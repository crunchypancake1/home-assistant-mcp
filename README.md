# Home Assistant MCP

An [MCP](https://modelcontextprotocol.io) server that exposes a Home
Assistant instance as a tool set, running as a stateful agent on Cloudflare
Workers. Point an MCP client (Claude, etc.) at the deployed endpoint and it
can read entity states, call services, run scripts and automations, and send
commands to phones via the HA companion app — all against your own Home
Assistant instance.

## How it works

```
MCP client ──HTTP/SSE──► Worker (/mcp) ──► HomeAssistantMCP (Durable Object)
                                                    │
                                          HomeAssistantClient
                                                    │
                                      Home Assistant REST API (Bearer auth)
```

`HomeAssistantMCP` is a [`McpAgent`](https://github.com/cloudflare/agents)
hosted on a Durable Object; each tool call goes through `HomeAssistantClient`,
a thin wrapper around the HA REST API that handles auth, path-safe entity
IDs, and error normalization. Areas have no dedicated REST endpoint in HA, so
`listAreas` / `getEntitiesByArea` go through `/api/template` with a small
Jinja template instead.

## Tools

| Tool | Description |
|---|---|
| `get_entities` | List entity states, optionally filtered by domain |
| `get_entity_state` | Full state and attributes for one entity |
| `call_service` | Call any HA service (`light.turn_on`, `lock.lock`, ...) |
| `list_areas` | List configured areas (rooms) |
| `get_entities_by_area` | Entity IDs belonging to an area |
| `list_automations` | Automations with state and last-triggered time |
| `trigger_automation` | Trigger an automation, bypassing conditions |
| `list_scripts` | Scripts with their running state |
| `run_script` | Run a script |
| `get_entity_history` | Recent state history for an entity |
| `phone_list_capabilities` | List commands sendable to the HA mobile app |
| `phone_send_command` | Send a command (e.g. DND toggle) to a phone |

## Setup

```bash
npm install
```

`HA_URL` is set in `wrangler.jsonc` under `vars` — point it at your own Home
Assistant instance before deploying.

`HA_TOKEN` (a long-lived access token from HA) is read from Cloudflare's
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
npm run dev         # wrangler dev
npm test             # vitest run
npm run test:watch   # vitest watch mode
```

Tests cover `HomeAssistantClient` by mocking `fetch` — no live Home
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
