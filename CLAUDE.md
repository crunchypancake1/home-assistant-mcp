# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # local dev via wrangler dev
npm run deploy     # deploy to Cloudflare Workers
npm test           # run tests once (vitest)
npm run test:watch # vitest in watch mode
npm run typecheck  # tsc --noEmit
```

Run a single test file: `npx vitest run test/catalog.test.ts`

## Architecture

This is a **Cloudflare Workers MCP server** that exposes Home Assistant as an MCP tool set. It uses
the [Cloudflare Agents SDK](https://github.com/cloudflare/agents) (`agents/mcp`) to host a stateful
MCP agent on a Durable Object.

```
MCP client ──HTTP/SSE──► Worker (/mcp) ──► HomeAssistantMCP (Durable Object)
                                                    │
                                             EntityCatalog  ← all caching lives here
                                                    │
                                          HomeAssistantClient
                                                    │
                     HA REST API + /api/websocket (Bearer / long-lived token)
```

### Key components

- **`src/index.ts`** — Worker entry point; `HomeAssistantMCP.serve("/mcp", { binding: "HA_MCP" })`.
- **`src/agent.ts`** — `HomeAssistantMCP extends McpAgent<Env>`. Registers the tools in `init()`,
  renders their text output, and carries the server `instructions` string that tells a calling model
  how the tool set is meant to be used.
- **`src/ha/catalog.ts`** — `EntityCatalog`: the queryable view of the house. Joins states to areas
  and floors, narrows them to the exposed set, resolves friendly names to entity IDs, and owns every
  cache. Holds no Workers-runtime imports, so tests can exercise it directly.
- **`src/ha/api.ts`** — `HomeAssistantClient`: thin, cache-free wrapper around the HA REST API plus
  the one WebSocket command below. Normalises errors into `HaApiError`, including HA's response body.
- **`src/ha/format.ts`** — pure rendering helpers (compact entity lines, durations, history
  summaries). No I/O, so it is unit-testable in isolation.
- **`src/ha/phone-commands.ts`** — `PHONE_COMMANDS`: manifest of commands sendable to the HA
  companion app via `notify.mobile_app_*`.
- **`src/types.ts`** — `Env`, `HaState`, `HaArea`, `HaRegistry`, `HaHistoryEntry`.

### The exposed-entity set

`/api/states` on a real installation is hundreds of kilobytes of entities, most of them diagnostics
no one would ask about by voice. The tool surface is therefore scoped to the entities the user
exposed in **Settings → Voice assistants → Expose**.

That list is only reachable over the WebSocket API — `homeassistant/expose_entity/list`, which has no
REST equivalent and is `@require_admin`, so `HA_TOKEN` must belong to an admin user. The Worker opens
the socket with `fetch(url, { headers: { Upgrade: "websocket" } })`, runs HA's
`auth_required` → `auth` → `auth_ok` handshake, sends the one command and closes.

When that fails — non-admin token, socket refused, or the list comes back empty because the user has
never opened the Expose page — the catalog falls back to Home Assistant's *own* default-exposure
rules, mirrored in `catalog.ts` from `homeassistant/components/homeassistant/exposed_entities.py`
(`DEFAULT_EXPOSED_DOMAINS` plus the default-exposed `sensor`/`binary_sensor` device classes, minus
hidden entities). `Exposure.note` then explains the situation and `list_areas` surfaces it.

A query narrow enough to match no exposed entity (`domain: "automation"`, say) automatically widens
to the unexposed ones and says so, so a caller never has to retry with `include_unexposed`.

### Service-call targeting

`EntityCatalog.resolveServiceData` normalises a `call_service` payload before it reaches HA. Three
things a calling model gets wrong otherwise:

- **`target` is nested.** HA's YAML puts `entity_id` under `target:`, so models emit it that way, but
  `POST /api/services/...` reads the targeting keys off the top level and rejects the nested form. It
  is unwrapped.
- **`entity_id: "all"` is a literal.** HA resolves `all`/`none` itself; passing them through the name
  resolver would match some unrelated entity whose name contains "all".
- **Names, not IDs.** `entity_id` and `area_id` accept friendly names, room names and floor names, and
  are resolved to IDs; an unresolvable reference is reported with the offending string rather than
  being sent on.

### Caching

The Durable Object outlives a single tool call, so `EntityCatalog` caches through a `Slot<T>` that
holds the **in-flight promise** rather than the resolved value — concurrent handlers cannot all miss
at once and stampede HA — and drops a rejected load instead of pinning the failure for the TTL.

| Cache | TTL | Invalidated by |
|---|---|---|
| `/api/states` | 3 s | `invalidateStates()` after every service call |
| Registry (areas, floors, hidden) | 10 min | `invalidateAll()` |
| Expose list | 10 min | `invalidateAll()` |

The 3-second states TTL is what collapses a multi-tool assistant turn into a single request to HA.
The Expose list is cached separately from the fallback so the fallback is always computed against
current states, not against whatever states were loaded when the Expose call last failed.

### Jinja templates

Areas, floors, area membership and the hidden-entity set have no REST endpoint, so they come from one
`POST /api/template` render, cached for 10 minutes.

**Jinja2 has no list comprehensions.** `{{ [{"area_id": a} for a in areas()] }}` is a
`TemplateSyntaxError`, not a working template — build lists with `{% set ns = namespace(...) %}` and
a `{% for %}` loop instead. `test/ha-api.test.ts` asserts the template does not regress to a
comprehension.

### Runtime environment

- `HA_URL` is a `vars` entry in `wrangler.jsonc` (`https://home.crunchypancake.com`).
- `HA_TOKEN` is a Secrets Store binding (`secrets_store_secrets`), pointing at the
  `home-assistant-token` secret. It's an async binding — read via `await env.HA_TOKEN.get()` (done
  once in `agent.ts#init`), not a plain string like a `vars` entry. It must belong to an **admin**
  HA user for the Expose list to be readable.
- `HA_ASSISTANT` is an optional `vars` entry naming the assistant whose Expose list to use; it
  defaults to `conversation` (the others are `cloud.alexa` and `cloud.google_assistant`).
- The Durable Object is declared with `new_sqlite_classes` (migration tag `v1`).
- Route: `home.crunchypancake.com/mcp` (zone `crunchypancake.com`). The Worker's own subrequests to
  `/api/*` on that same hostname fall through to Home Assistant, since the route is path-scoped.

### Tests

Vitest with `environment: "node"`; `globalThis.fetch` is mocked via `vi.spyOn`, so no live HA
instance is needed. `test/ha-api.test.ts` drives the WebSocket handshake against a fake socket,
`test/catalog.test.ts` exercises filtering, exposure fallback, caching and name resolution against a
stub client, and `test/format.test.ts` covers the pure renderers. The MCP agent layer itself is not
tested.
