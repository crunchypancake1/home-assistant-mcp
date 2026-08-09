# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # local dev via wrangler dev
npm run deploy     # deploy to Cloudflare Workers
npm test           # run tests once (vitest)
npm run test:watch # vitest in watch mode
```

Run a single test file: `npx vitest run test/ha-api.test.ts`

## Architecture

This is a **Cloudflare Workers MCP server** that exposes Home Assistant as an MCP tool set. It uses the [Cloudflare Agents SDK](https://github.com/cloudflare/agents) (`agents/mcp`) to host a stateful MCP agent on a Durable Object.

### Key components

- **`src/index.ts`** — Worker entry point; calls `HomeAssistantMCP.serve("/mcp", { binding: "HA_MCP" })` to bind the Durable Object and expose the MCP endpoint.
- **`src/agent.ts`** — `HomeAssistantMCP extends McpAgent<Env>`. All MCP tools are registered inside `init()` using `this.server.registerTool(...)`. The `McpServer` instance lives at `this.server`.
- **`src/ha/api.ts`** — `HomeAssistantClient`: thin wrapper around the HA REST API. Handles auth (Bearer token), path-safety (`encodeURIComponent`), and response error normalisation. `listAreas()` / `getEntitiesByArea()` use the `/api/template` endpoint with a Jinja template since HA has no direct areas REST endpoint.
- **`src/ha/phone-commands.ts`** — `PHONE_COMMANDS`: manifest of commands sendable to the HA companion app via the `notify.mobile_app_*` service, used by the `phone_list_capabilities` / `phone_send_command` tools.
- **`src/types.ts`** — Shared types: `Env` (Worker bindings + vars), `HaState`, `HaArea`, `HaHistoryEntry`.

### Runtime environment

- `HA_URL` is set as a `vars` entry in `wrangler.jsonc` (points to `https://home.crunchypancake.com`).
- `HA_TOKEN` must be set as a Wrangler secret (`wrangler secret put HA_TOKEN`).
- The Durable Object is declared with `new_sqlite_classes` (migration tag `v1`).
- Route: `home.crunchypancake.com/mcp` (zone `crunchypancake.com`).

### Tests

Tests use Vitest with `environment: "node"`. They mock `globalThis.fetch` via `vi.spyOn` — no real HA instance needed. Tests cover `HomeAssistantClient` only; the MCP agent layer is not tested.
