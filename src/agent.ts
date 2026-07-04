import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HomeAssistantClient } from "./ha/api";
import type { Env } from "./types";

export class HomeAssistantMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Home Assistant", version: "1.0.0" });

  async init(): Promise<void> {
    const client = new HomeAssistantClient(this.env.HA_URL, this.env.HA_TOKEN);

    this.server.registerTool(
      "get_entities",
      {
        description:
          "List Home Assistant entity states, optionally filtered by domain (e.g. 'light', 'switch', 'sensor').",
        inputSchema: {
          domain: z
            .string()
            .optional()
            .describe("Entity domain to filter by (e.g. 'light', 'sensor', 'switch')"),
        },
      },
      async ({ domain }) => {
        try {
          const states = await client.getStates(domain);
          return { content: [{ type: "text" as const, text: JSON.stringify(states) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );

    this.server.registerTool(
      "get_entity_state",
      {
        description:
          "Get the full state and attributes of a specific Home Assistant entity.",
        inputSchema: {
          entity_id: z
            .string()
            .min(1)
            .describe("Entity ID (e.g. 'light.living_room', 'sensor.temperature')"),
        },
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

    this.server.registerTool(
      "call_service",
      {
        description:
          "Call a Home Assistant service (e.g. turn lights on/off, lock a door). Pass service_data directly to HA.",
        inputSchema: {
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
      },
      async ({ domain, service, service_data }) => {
        try {
          const affected = await client.callService(domain, service, service_data ?? {});
          const text =
            affected.length === 0
              ? `Service ${domain}.${service} called successfully (no affected entities returned).`
              : JSON.stringify(affected);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );

    this.server.registerTool(
      "list_areas",
      {
        description:
          "List all configured areas (rooms) in Home Assistant.",
        inputSchema: {},
      },
      async () => {
        try {
          const areas = await client.listAreas();
          return { content: [{ type: "text" as const, text: JSON.stringify(areas) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );

    this.server.registerTool(
      "list_automations",
      {
        description:
          "List all automations in Home Assistant with their ID, friendly name, state (on/off), and last triggered time.",
        inputSchema: {},
      },
      async () => {
        try {
          const states = await client.getStates("automation");
          const automations = states.map((s) => ({
            entity_id: s.entity_id,
            name: (s.attributes["friendly_name"] as string | undefined) ?? s.entity_id,
            enabled: s.state === "on",
            last_triggered: (s.attributes["last_triggered"] as string | undefined) ?? null,
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify(automations) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );

    this.server.registerTool(
      "trigger_automation",
      {
        description:
          "Trigger a Home Assistant automation by entity ID, bypassing any conditions.",
        inputSchema: {
          entity_id: z
            .string()
            .regex(/^automation\./, "entity_id must be an automation entity (e.g. 'automation.good_morning')")
            .describe("Automation entity ID (e.g. 'automation.good_morning')"),
        },
      },
      async ({ entity_id }) => {
        try {
          await client.callService("automation", "trigger", {
            entity_id,
            skip_condition: true,
          });
          return {
            content: [{ type: "text" as const, text: `Automation ${entity_id} triggered.` }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );

    this.server.registerTool(
      "list_scripts",
      {
        description:
          "List all scripts in Home Assistant with their ID, friendly name, and current running state.",
        inputSchema: {},
      },
      async () => {
        try {
          const states = await client.getStates("script");
          const scripts = states.map((s) => ({
            entity_id: s.entity_id,
            name: (s.attributes["friendly_name"] as string | undefined) ?? s.entity_id,
            running: s.state === "on",
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify(scripts) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );

    this.server.registerTool(
      "run_script",
      {
        description: "Run a Home Assistant script by entity ID.",
        inputSchema: {
          entity_id: z
            .string()
            .regex(/^script\./, "entity_id must be a script entity (e.g. 'script.goodnight_routine')")
            .describe("Script entity ID (e.g. 'script.goodnight_routine')"),
        },
      },
      async ({ entity_id }) => {
        try {
          await client.callService("script", "turn_on", { entity_id });
          return {
            content: [{ type: "text" as const, text: `Script ${entity_id} started.` }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );

    this.server.registerTool(
      "get_entity_history",
      {
        description:
          "Get the recent state history for a Home Assistant entity. Returns a list of state changes with timestamps. Useful for questions like 'how long has the light been on' or 'when did the door last open'.",
        inputSchema: {
          entity_id: z
            .string()
            .min(1)
            .describe("Entity ID to query history for (e.g. 'light.living_room')"),
          hours_back: z
            .number()
            .int()
            .min(1)
            .max(168)
            .optional()
            .describe("How many hours of history to retrieve (default: 24, max: 168)"),
        },
      },
      async ({ entity_id, hours_back }) => {
        try {
          const history = await client.getEntityHistory(entity_id, hours_back ?? 24);
          return { content: [{ type: "text" as const, text: JSON.stringify(history) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );
  }
}
