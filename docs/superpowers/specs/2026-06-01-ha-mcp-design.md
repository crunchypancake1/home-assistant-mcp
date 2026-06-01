# Home Assistant MCP Worker — Design Spec

**Date:** 2026-06-01
**Status:** Approved

---

## Overview

A Cloudflare Worker that exposes Home Assistant controls as an MCP server, following the same `McpAgent` Durable Object pattern used in linkwarden-mcp and joplin-mcp. No indexer, no AI search, no cron — just a direct passthrough gateway from MCP clients to the HA REST API.

---

## Architecture

```
src/
  index.ts        — Worker entry point; exports HomeAssistantMCP + default fetch handler
  agent.ts        — HomeAssistantMCP (extends McpAgent), registers all tools in init()
  ha/
    api.ts        — HomeAssistantClient; typed fetch wrapper around HA REST API
  types.ts        — Env interface, HA entity/state/service types
```

### Entry point (`index.ts`)

Follows the exact pattern of linkwarden-mcp/joplin-mcp:

```ts
export { HomeAssistantMCP };
export default {
  ...HomeAssistantMCP.serve("/mcp", { binding: "HA_MCP" }),
};
```

No `scheduled` export — there is no indexer.

### Agent (`agent.ts`)

`HomeAssistantMCP extends McpAgent<Env>`. Constructs a `HomeAssistantClient` from env vars in `init()`, then calls a single `registerTools(server, client)` function.

### API client (`ha/api.ts`)

`HomeAssistantClient` encapsulates all HA REST calls:
- Constructor takes `baseUrl: string` and `token: string`
- Private `fetch()` method adds `Authorization: Bearer <token>` and handles non-2xx as thrown errors
- One method per tool (see Tools section)

---

## Tools

### `get_entities`

Lists all entity states from HA, optionally filtered by domain.

- **HA endpoint:** `GET /api/states`
- **Input:** `domain?: string` — if provided, filters entities client-side by matching `entity_id` prefix (`<domain>.`)
- **Output:** array of `{ entity_id, state, attributes, last_changed, last_updated }` as JSON text

### `get_entity_state`

Returns the full state object for a single entity.

- **HA endpoint:** `GET /api/states/<entity_id>`
- **Input:** `entity_id: string`
- **Output:** `{ entity_id, state, attributes, last_changed, last_updated }` as JSON text
- **Error:** returns `isError: true` with message if entity not found (404)

### `call_service`

Calls a Home Assistant service.

- **HA endpoint:** `POST /api/services/<domain>/<service>`
- **Input:** `domain: string`, `service: string`, `service_data?: object`
- **Output:** array of affected entity states as returned by HA, or confirmation message if empty
- **Examples:** `light.turn_on` with `{ entity_id: "light.living_room", brightness: 128 }`

### `list_areas`

Lists all configured areas (rooms) in Home Assistant.

- **HA endpoint:** `POST /api/template` with body containing a Jinja2 template that maps each area ID to its name
- **Template:** `{{ areas() | map('area_name') | list | tojson }}` returns names; implementation returns both ID and name by iterating area IDs with `area_name(id)` per entry
- **Input:** none
- **Output:** array of `{ area_id, name }` objects as JSON text

---

## Configuration

### `wrangler.jsonc`

| Resource | Type | Details |
|----------|------|---------|
| `HA_MCP` | Durable Object | class `HomeAssistantMCP`, `new_sqlite_classes` migration |
| `HA_URL` | Var | e.g. `https://ha.crunchypancake.com` |
| `HA_TOKEN` | Secret | HA long-lived access token (set via `wrangler secret put HA_TOKEN`) |
| Custom domain | Route | `ha-mcp.crunchypancake.com` |
| Cron | — | None |
| KV / R2 / AI | — | None |

### Auth flow

MCP clients connect to the Cloudflare Worker endpoint (`ha-mcp.crunchypancake.com/mcp`). The Worker authenticates inbound MCP connections using the Cloudflare AI Gateway / access controls (same pattern as the other workers). Outbound requests to HA use `Authorization: Bearer <HA_TOKEN>`.

---

## Types (`types.ts`)

```ts
interface Env {
  HA_MCP: DurableObjectNamespace;
  HA_URL: string;
  HA_TOKEN: string;
}

interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}
```

---

## Error Handling

- Non-2xx from HA REST API → throw `Error("HA API error: <status> <statusText>")`, propagated to MCP client as an error response
- 404 on `get_entity_state` → return `isError: true` with human-readable message (not a thrown error, consistent with joplin pattern)
- Malformed HA response → let it throw naturally; MCP framework surfaces as error

---

## Testing

Vitest unit tests for `HomeAssistantClient`:
- Mock `fetch` to simulate HA API responses
- Cover: `getStates`, `getEntityState` (found / not found), `callService`, `listAreas`
- No integration tests (requires live HA instance)

---

## Out of Scope (v1)

- Entity history (`GET /api/history`)
- Event firing (`POST /api/events/<event_type>`)
- Config/lovelace editing
- Add-on management
- WebSocket transport
- AI semantic search
