import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HomeAssistantClient } from "./ha/api";
import { EntityCatalog, type EntityInfo, type QueryResult, type Resolution } from "./ha/catalog";
import { entityLine, renderHistory, shortTime, stateWithUnit, summarizeHistory } from "./ha/format";
import { PHONE_COMMANDS } from "./ha/phone-commands";
import type { Env } from "./types";

const PHONE_COMMAND_NAMES = PHONE_COMMANDS.map((c) => c.command) as [string, ...string[]];

const DEFAULT_ASSISTANT = "conversation";
const DEFAULT_LIMIT = 200;
const ATTRIBUTE_CHAR_CAP = 2000;
const MAX_AFFECTED_SHOWN = 20;

const INSTRUCTIONS = `Home Assistant control for a smart-home assistant.

Start with get_entities. It returns only the entities the user exposed to their voice
assistant, grouped by area, one compact line each. Narrow with domain/area/search instead
of listing everything — the result is capped.

Entity arguments accept a friendly name ("kitchen ceiling") as well as an entity_id, so
there is no need to look up an ID first. Control things with call_service; use activate
for automations, scripts, scenes and buttons. get_entity_state gives the full attribute
set for a handful of entities, get_history answers "how long" and "when did it last".

Reads share a short-lived cache, so several reads in one turn cost one request to Home
Assistant; a service call invalidates it immediately.`;

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function areaLabel(entity: EntityInfo): string {
  if (!entity.area) return "(no area)";
  return entity.floor ? `${entity.area} — ${entity.floor}` : entity.area;
}

function renderEntities(result: QueryResult): string {
  if (result.matches.length === 0) {
    return "No entities matched. Widen the filters, or pass include_unexposed: true to search entities that are not exposed to the assistant.";
  }

  const groups = new Map<string, EntityInfo[]>();
  for (const entity of result.matches) {
    const label = areaLabel(entity);
    const bucket = groups.get(label);
    if (bucket) bucket.push(entity);
    else groups.set(label, [entity]);
  }

  const ordered = [...groups.entries()].sort(([a], [b]) => {
    if (a === "(no area)") return 1;
    if (b === "(no area)") return -1;
    return a.localeCompare(b);
  });

  const header =
    `${result.matches.length} of ${result.matched} matching entities` +
    (result.exposure.source === "defaults"
      ? " (exposure: Home Assistant defaults — the Expose list was unreachable; see list_areas)"
      : "");

  const notes: string[] = [];
  if (result.relaxed) {
    notes.push("No exposed entity matched, so unexposed entities are included in this result.");
  }
  if (result.truncated) {
    notes.push("Result truncated — narrow it with domain, area or search, or raise limit.");
  }

  const body = ordered.map(([label, entities]) =>
    [`## ${label}`, ...entities.map(entityLine)].join("\n"),
  );

  return [header, ...notes, "", ...body].join("\n");
}

function renderResolution(ref: string, resolution: Resolution): string {
  if (resolution.kind === "ambiguous") {
    const options = resolution.candidates.map((c) => `- ${c.entity_id} (${c.name})`).join("\n");
    return `"${ref}" matches several entities. Retry with one of:\n${options}`;
  }
  return `No entity matches "${ref}". Use get_entities with search to find it.`;
}

export class HomeAssistantMCP extends McpAgent<Env> {
  server = new McpServer(
    { name: "Home Assistant", version: "2.0.0" },
    { instructions: INSTRUCTIONS },
  );

  private client!: HomeAssistantClient;
  private catalog!: EntityCatalog;

  /** Resolves an entity_id-or-name to an ID, or to a message the caller can act on. */
  private async entityId(ref: string): Promise<{ id: string } | { error: string }> {
    const resolution = await this.catalog.resolve(ref);
    return resolution.kind === "one"
      ? { id: resolution.entity.entity_id }
      : { error: renderResolution(ref, resolution) };
  }

  async init(): Promise<void> {
    const token = await this.env.HA_TOKEN.get();
    this.client = new HomeAssistantClient(this.env.HA_URL, token);
    this.catalog = new EntityCatalog(this.client, this.env.HA_ASSISTANT?.trim() || DEFAULT_ASSISTANT);

    // ── get_entities ──────────────────────────────────────────────────────
    this.server.registerTool(
      "get_entities",
      {
        title: "List entities",
        description:
          "List Home Assistant entities with their current state, grouped by area. Returns only " +
          "entities exposed to the voice assistant (Settings → Voice assistants → Expose), one " +
          "compact line each. Combine the filters to keep results small; a filter that matches no " +
          "exposed entity automatically widens to unexposed ones (this is how automations, scripts " +
          "and diagnostic sensors are found). Use get_entity_state for an entity's full attributes.",
        inputSchema: {
          domain: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .describe("Domain or domains to include, e.g. 'light' or ['light','switch']"),
          area: z
            .string()
            .optional()
            .describe("Area, floor or area_id to filter by — matched loosely, e.g. 'kitchen', 'upstairs'"),
          search: z
            .string()
            .optional()
            .describe("Match entity IDs and friendly names; all words must appear, e.g. 'ceiling lamp'"),
          state: z
            .string()
            .optional()
            .describe("Only entities currently in this exact state, e.g. 'on', 'unavailable'"),
          include_unexposed: z
            .boolean()
            .optional()
            .describe("Include entities not exposed to the assistant (default false). Expect a lot of noise."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe(`Maximum entities to return (default ${DEFAULT_LIMIT})`),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ domain, area, search, state, include_unexposed, limit }) => {
        try {
          const result = await this.catalog.query({
            domains: domain === undefined ? undefined : Array.isArray(domain) ? domain : [domain],
            area,
            search,
            state,
            includeUnexposed: include_unexposed,
            limit: limit ?? DEFAULT_LIMIT,
          });
          return text(renderEntities(result));
        } catch (err) {
          return failure(errorText(err));
        }
      },
    );

    // ── get_entity_state ──────────────────────────────────────────────────
    this.server.registerTool(
      "get_entity_state",
      {
        title: "Read entity details",
        description:
          "Read the full state and attributes of up to 20 entities in one call. Each entity may be " +
          "given as an entity_id or as a friendly name. Use this only when the compact line from " +
          "get_entities is not enough — attribute payloads are large.",
        inputSchema: {
          entities: z
            .array(z.string().min(1))
            .min(1)
            .max(20)
            .describe("Entity IDs or friendly names, e.g. ['light.living_room', 'kitchen ceiling']"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ entities }) => {
        try {
          const snapshot = await this.catalog.snapshot();
          const blocks = await Promise.all(
            entities.map(async (ref) => {
              const resolution = await this.catalog.resolve(ref);
              if (resolution.kind !== "one") return renderResolution(ref, resolution);
              const entity = snapshot.byId.get(resolution.entity.entity_id) ?? resolution.entity;
              let attributes = JSON.stringify(entity.attributes);
              if (attributes.length > ATTRIBUTE_CHAR_CAP) {
                attributes = `${attributes.slice(0, ATTRIBUTE_CHAR_CAP)}… [truncated, ${attributes.length} chars]`;
              }
              return [
                `${entity.entity_id} | ${entity.name} | ${areaLabel(entity)}${entity.exposed ? "" : " | not exposed"}`,
                `state: ${stateWithUnit(entity.state, entity.attributes)} (since ${shortTime(entity.last_changed)} UTC)`,
                `attributes: ${attributes}`,
              ].join("\n");
            }),
          );
          return text(blocks.join("\n\n"));
        } catch (err) {
          return failure(errorText(err));
        }
      },
    );

    // ── call_service ──────────────────────────────────────────────────────
    this.server.registerTool(
      "call_service",
      {
        title: "Call a service",
        description:
          "Call a Home Assistant service — the general way to control anything (turn_on, set_temperature, " +
          "media_play, lock, …). Put entity_id and area_id directly in service_data; either may be a " +
          "friendly name, a room name or a list, and both are resolved to IDs before the call. " +
          "For automations, scripts, scenes and buttons prefer the activate tool.",
        inputSchema: {
          domain: z.string().min(1).describe("Service domain, e.g. 'light', 'climate', 'homeassistant'"),
          service: z.string().min(1).describe("Service name, e.g. 'turn_on', 'toggle', 'set_temperature'"),
          service_data: z
            .record(z.unknown())
            .optional()
            .describe("Service payload, e.g. { entity_id: 'light.living_room', brightness_pct: 50 }"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ domain, service, service_data }) => {
        try {
          const targeted = await this.catalog.resolveServiceData(service_data ?? {});
          if (targeted.kind === "entity") return failure(renderResolution(targeted.ref, targeted.resolution));
          if (targeted.kind === "area") {
            return failure(`No area matches "${targeted.ref}". Use list_areas to see what exists.`);
          }

          const affected = await this.client.callService(domain, service, targeted.data);
          this.catalog.invalidateStates();

          if (affected.length === 0) {
            return text(`${domain}.${service} called. Home Assistant reported no changed entities.`);
          }
          const shown = affected.slice(0, MAX_AFFECTED_SHOWN);
          const lines = shown.map((state) =>
            entityLine({
              entity_id: state.entity_id,
              name: (state.attributes["friendly_name"] as string | undefined) ?? state.entity_id,
              state: state.state,
              attributes: state.attributes,
            }),
          );
          const more =
            affected.length > shown.length ? [`… and ${affected.length - shown.length} more`] : [];
          return text([`${domain}.${service} called. Now:`, ...lines, ...more].join("\n"));
        } catch (err) {
          return failure(errorText(err));
        }
      },
    );

    // ── activate ──────────────────────────────────────────────────────────
    this.server.registerTool(
      "activate",
      {
        title: "Run an automation, script, scene or button",
        description:
          "Make something happen: triggers an automation (skipping its conditions), runs a script, " +
          "applies a scene, or presses a button. Accepts an entity_id or a friendly name.",
        inputSchema: {
          entity: z
            .string()
            .min(1)
            .describe("Automation, script, scene, button or input_button — by entity_id or name"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ entity }) => {
        try {
          const lookup = await this.entityId(entity);
          if ("error" in lookup) return failure(lookup.error);
          const entityId = lookup.id;
          const domain = entityId.slice(0, entityId.indexOf("."));

          const dispatch: Record<string, { service: string; data?: Record<string, unknown> }> = {
            automation: { service: "trigger", data: { skip_condition: true } },
            script: { service: "turn_on" },
            scene: { service: "turn_on" },
            button: { service: "press" },
            input_button: { service: "press" },
          };
          const action = dispatch[domain];
          if (!action) {
            return failure(
              `${entityId} is a '${domain}' entity, which has nothing to activate. Use call_service instead.`,
            );
          }

          await this.client.callService(domain, action.service, {
            entity_id: entityId,
            ...(action.data ?? {}),
          });
          this.catalog.invalidateStates();
          return text(`${entityId} activated (${domain}.${action.service}).`);
        } catch (err) {
          return failure(errorText(err));
        }
      },
    );

    // ── list_areas ────────────────────────────────────────────────────────
    this.server.registerTool(
      "list_areas",
      {
        title: "List areas",
        description:
          "List the areas (rooms) configured in Home Assistant with their floor and how many " +
          "entities each holds. Use the area name with get_entities to see what is in a room.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async () => {
        try {
          const snapshot = await this.catalog.snapshot();
          if (snapshot.areas.length === 0) {
            return text("No areas are configured in Home Assistant.");
          }
          const lines = snapshot.areas.map(
            (area) =>
              `${area.name} (${area.area_id})${area.floor ? ` — ${area.floor}` : ""} — ` +
              `${area.exposed} exposed of ${area.total} entities`,
          );
          const note = snapshot.exposure.note ? ["", `Note: ${snapshot.exposure.note}`] : [];
          return text([...lines, ...note].join("\n"));
        } catch (err) {
          return failure(errorText(err));
        }
      },
    );

    // ── get_history ───────────────────────────────────────────────────────
    this.server.registerTool(
      "get_history",
      {
        title: "Entity history",
        description:
          "Summarise recent state history for up to 10 entities: total time spent in each state plus " +
          "the list of changes. Answers 'how long has the heating been on', 'when did the door last open'.",
        inputSchema: {
          entities: z
            .array(z.string().min(1))
            .min(1)
            .max(10)
            .describe("Entity IDs or friendly names"),
          hours_back: z
            .number()
            .int()
            .min(1)
            .max(168)
            .optional()
            .describe("Window size in hours (default 24, max 168)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ entities, hours_back }) => {
        try {
          const ids: string[] = [];
          const problems: string[] = [];
          for (const ref of entities) {
            const lookup = await this.entityId(ref);
            if ("error" in lookup) problems.push(lookup.error);
            else ids.push(lookup.id);
          }
          if (ids.length === 0) return failure(problems.join("\n\n"));

          const hours = hours_back ?? 24;
          const series = await this.client.getHistory(ids, hours);
          const now = Date.now();
          const byId = new Map(
            series
              .filter((entries) => entries.length > 0)
              .map((entries) => [entries[0]!.entity_id ?? "", entries] as const),
          );

          const blocks = ids.map((id) =>
            renderHistory(summarizeHistory(id, byId.get(id) ?? [], now)),
          );
          return text([`Last ${hours}h:`, ...blocks, ...problems].join("\n\n"));
        } catch (err) {
          return failure(errorText(err));
        }
      },
    );

    // ── phone_list_capabilities ───────────────────────────────────────────
    this.server.registerTool(
      "phone_list_capabilities",
      {
        title: "List phone commands",
        description:
          "List the commands that can be sent to a phone through Home Assistant's companion-app " +
          "notification service, with their parameters. The service name is 'mobile_app_<device_name>' " +
          "as the device is named in the companion app — ask the user if it is unknown.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => text(JSON.stringify(PHONE_COMMANDS)),
    );

    // ── phone_send_command ────────────────────────────────────────────────
    this.server.registerTool(
      "phone_send_command",
      {
        title: "Send a phone command",
        description:
          "Send a command to a phone via the Home Assistant companion-app notification service. " +
          "See phone_list_capabilities for the commands and their parameters.",
        inputSchema: {
          notify_service: z
            .string()
            .regex(/^mobile_app_/, "must start with 'mobile_app_' (e.g. 'mobile_app_pixel_8')")
            .describe("Notify service for the target device, e.g. 'mobile_app_pixel_8'"),
          command: z
            .enum(PHONE_COMMAND_NAMES)
            .describe("Command to send, e.g. 'command_dnd'. See phone_list_capabilities."),
          command_data: z
            .record(z.unknown())
            .optional()
            .describe("Command parameters as a key-value object, per phone_list_capabilities."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ notify_service, command, command_data }) => {
        try {
          await this.client.callService("notify", notify_service, {
            message: command,
            data: command_data ?? {},
          });
          return text(`Command ${command} sent to ${notify_service}.`);
        } catch (err) {
          return failure(errorText(err));
        }
      },
    );
  }
}
