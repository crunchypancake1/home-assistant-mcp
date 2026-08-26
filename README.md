# Home Assistant MCP

An [MCP](https://modelcontextprotocol.io) server that exposes a Home
Assistant instance as a tool set, running as a stateful agent on Cloudflare
Workers. Point an MCP client (Claude, etc.) at the deployed endpoint and it
can read entity states, call services, run scripts and automations, and send
commands to phones via the HA companion app — all against your own Home
Assistant instance.

The tool surface is built for a model rather than for the REST API: results
are scoped to the entities you exposed to your voice assistant, rendered as
one compact line per entity grouped by room, and every entity argument
accepts a friendly name as readily as an `entity_id`.

## How it works

```
MCP client ──HTTP/SSE──► Worker (/mcp) ──► HomeAssistantMCP (Durable Object)
                                                    │
                                             EntityCatalog
                                                    │
                                          HomeAssistantClient
                                                    │
                     HA REST API + /api/websocket (long-lived token)
```

`HomeAssistantMCP` is a [`McpAgent`](https://github.com/cloudflare/agents)
hosted on a Durable Object. `EntityCatalog` sits between the tools and the
API: it joins entity states to their area and floor, narrows them to the
exposed set, resolves friendly names to entity IDs, and caches everything.
`HomeAssistantClient` underneath is a thin, cache-free wrapper around the HA
REST API. Areas, floors and hidden entities have no REST endpoint, so they
come from a single `/api/template` Jinja render.

### Only what you exposed

`/api/states` on a real installation is a wall of firmware-update notices,
signal-strength sensors and diagnostic switches. So the server scopes itself
to the entities you picked in **Settings → Voice assistants → Expose**, read
over the WebSocket API (`homeassistant/expose_entity/list` — there is no REST
equivalent, and it requires a token belonging to an admin user).

If that list can't be read, the server falls back to Home Assistant's own
default-exposure rules — lights, switches, covers, climate, media players and
the handful of sensor device classes HA itself exposes by default — and says
so in `list_areas`. A filter narrow enough to match nothing exposed (say
`domain: "automation"`) widens automatically, so nothing is unreachable.

### Caching

The Durable Object outlives a tool call, so a multi-tool turn costs one
request to Home Assistant rather than one per tool: states are cached for
3 seconds and invalidated the moment a service call changes something, while
the area registry and the Expose list are cached for 10 minutes.

## Tools

| Tool | Description |
|---|---|
| `get_entities` | Exposed entities grouped by area, filtered by domain / area / search / state |
| `get_entity_state` | Full state and attributes for up to 20 entities at once |
| `call_service` | Call any HA service (`light.turn_on`, `climate.set_temperature`, ...) |
| `activate` | Trigger an automation, run a script, apply a scene, press a button |
| `list_areas` | Areas with their floor and entity counts |
| `get_history` | Time spent in each state plus the changes, for up to 10 entities |
| `phone_list_capabilities` | List commands sendable to the HA mobile app |
| `phone_send_command` | Send a command (e.g. DND toggle) to a phone |

`get_entities` returns lines like:

```
## Kitchen — Ground
light.kitchen_ceiling | Kitchen Ceiling | on | brightness=71%
sensor.kitchen_temp | Kitchen Temperature | 21.4 °C
```

Anything taking an entity — `get_entity_state`, `call_service`'s
`entity_id`, `activate`, `get_history` — accepts `"kitchen ceiling"` just as
well as `light.kitchen_ceiling`, and answers an ambiguous name with the
candidates rather than a guess.

## Setup

```bash
npm install
```

`HA_URL` is set in `wrangler.jsonc` under `vars` — point it at your own Home
Assistant instance before deploying. `HA_ASSISTANT` is optional and names the
assistant whose Expose list to use; it defaults to `conversation`.

`HA_TOKEN` (a long-lived access token from HA, belonging to an **admin**
user so the Expose list is readable) is read from Cloudflare's
[Secrets Store](https://developers.cloudflare.com/secrets-store/), not a
plain Wrangler secret. Create it once per account and it's reusable across
Workers:

```bash
wrangler secrets-store secret create <store-id> \
  --name home-assistant-token --scopes workers --remote
```

`wrangler.jsonc` then binds it via `secrets_store_secrets`:

```jsonc
"secrets_store_secrets": [
  { "binding": "HA_TOKEN", "store_id": "<store-id>", "secret_name": "home-assistant-token" }
]
```

For local dev, create a local-only secret with the same name (omit
`--remote`) so `wrangler dev` has something to read.

## Development

```bash
npm run dev          # wrangler dev
npm test             # vitest run
npm run test:watch   # vitest watch mode
npm run typecheck    # tsc --noEmit
```

Tests mock `fetch` — including the WebSocket handshake — so no live Home
Assistant instance is required to run them.

## Deploy

```bash
npm run deploy
```

Or connect this repository to a Cloudflare Worker for git-based deploys.
Either way, the `home-assistant-token` secret must exist in the account's
Secrets Store — it is never stored in the repo.

## Stack

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) + Durable
  Objects (SQLite-backed)
- [Cloudflare Agents SDK](https://github.com/cloudflare/agents) (`agents/mcp`)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- TypeScript, [Zod](https://zod.dev/) for tool input schemas, [Vitest](https://vitest.dev/)
