import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HomeAssistantClient } from "./ha/api";
import type { Env } from "./types";

export class HomeAssistantMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Home Assistant", version: "1.0.0" });

  async init(): Promise<void> {
    const client = new HomeAssistantClient(this.env.HA_URL, this.env.HA_TOKEN);

    this.server.tool(
      "get_entities",
      "List Home Assistant entity states, optionally filtered by domain (e.g. 'light', 'switch', 'sensor').",
      {
        domain: z
          .string()
          .optional()
          .describe("Entity domain to filter by (e.g. 'light', 'sensor', 'switch')"),
      },
      async ({ domain }) => {
        const states = await client.getStates(domain);
        return { content: [{ type: "text" as const, text: JSON.stringify(states) }] };
      },
    );

    this.server.tool(
      "get_entity_state",
      "Get the full state and attributes of a specific Home Assistant entity.",
      {
        entity_id: z
          .string()
          .describe("Entity ID (e.g. 'light.living_room', 'sensor.temperature')"),
      },
      async ({ entity_id }) => {
        const state = await client.getEntityState(entity_id);
        if (state === null) {
          return {
            content: [{ type: "text" as const, text: `Entity not found: ${entity_id}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(state) }] };
      },
    );

    this.server.tool(
      "call_service",
      "Call a Home Assistant service (e.g. turn lights on/off, lock a door). Pass service_data directly to HA.",
      {
        domain: z
          .string()
          .describe("Service domain (e.g. 'light', 'switch', 'homeassistant')"),
        service: z
          .string()
          .describe("Service name (e.g. 'turn_on', 'turn_off', 'toggle')"),
        service_data: z
          .record(z.unknown())
          .optional()
          .describe(
            "Service data payload (e.g. { entity_id: 'light.living_room', brightness: 128 })",
          ),
      },
      async ({ domain, service, service_data }) => {
        const affected = await client.callService(domain, service, service_data ?? {});
        const text =
          affected.length === 0
            ? `Service ${domain}.${service} called successfully (no affected entities returned).`
            : JSON.stringify(affected);
        return { content: [{ type: "text" as const, text }] };
      },
    );

    this.server.tool(
      "list_areas",
      "List all configured areas (rooms) in Home Assistant.",
      {},
      async () => {
        const areas = await client.listAreas();
        return { content: [{ type: "text" as const, text: JSON.stringify(areas) }] };
      },
    );
  }
}
