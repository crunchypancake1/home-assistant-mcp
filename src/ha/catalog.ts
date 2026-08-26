import type { HomeAssistantClient } from "./api";
import { domainOf } from "./format";
import type { HaArea, HaState } from "../types";

// The Durable Object outlives a single tool call, so these caches are what make a
// multi-tool assistant turn cost one round trip to Home Assistant instead of six.
const STATES_TTL_MS = 3_000;
const REGISTRY_TTL_MS = 10 * 60_000;
const EXPOSURE_TTL_MS = 10 * 60_000;

/**
 * Home Assistant's own "expose by default" rules, mirrored from
 * `homeassistant/components/homeassistant/exposed_entities.py`. Used only when the
 * Expose list itself is unreachable.
 */
const DEFAULT_EXPOSED_DOMAINS = new Set([
  "climate", "cover", "fan", "humidifier", "light", "media_player",
  "scene", "switch", "todo", "vacuum", "water_heater",
]);
const DEFAULT_EXPOSED_BINARY_SENSOR_CLASSES = new Set([
  "door", "garage_door", "lock", "motion", "opening", "presence", "window",
]);
const DEFAULT_EXPOSED_SENSOR_CLASSES = new Set([
  "aqi", "carbon_monoxide", "carbon_dioxide", "humidity", "pm10", "pm25",
  "temperature", "volatile_organic_compounds",
]);

const MAX_CANDIDATES = 8;

// Home Assistant resolves these itself ("every entity in the domain"); running them
// through the name resolver would match some unrelated entity containing "all".
const LITERAL_TARGETS = new Set(["all", "none"]);

/**
 * A TTL cache of one value. It holds the in-flight promise rather than the resolved
 * value, so concurrent tool handlers cannot all miss at once and stampede Home
 * Assistant, and a rejected load is dropped rather than pinned in place by the TTL.
 */
class Slot<T> {
  private cached: { at: number; value: Promise<T> } | null = null;

  constructor(private readonly ttlMs: number) {}

  clear(): void {
    this.cached = null;
  }

  get(load: () => Promise<T>): Promise<T> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.value;
    const value = load();
    this.cached = { at: Date.now(), value };
    return value.catch((err: unknown) => {
      if (this.cached?.value === value) this.cached = null;
      throw err;
    });
  }
}

export interface EntityInfo {
  entity_id: string;
  domain: string;
  name: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  areaId: string | null;
  area: string | null;
  floor: string | null;
  exposed: boolean;
}

export type ExposureSource = "expose" | "defaults";

export interface Exposure {
  ids: Set<string>;
  source: ExposureSource;
  note: string | null;
}

export interface AreaSummary {
  area_id: string;
  name: string;
  floor: string | null;
  total: number;
  exposed: number;
}

export interface Snapshot {
  entities: EntityInfo[];
  byId: Map<string, EntityInfo>;
  areas: AreaSummary[];
  exposure: Exposure;
}

export interface EntityQuery {
  domains?: string[];
  area?: string;
  search?: string;
  state?: string;
  includeUnexposed?: boolean;
  limit?: number;
}

export interface QueryResult {
  matches: EntityInfo[];
  matched: number;
  truncated: boolean;
  /** True when an exposed-only query found nothing and the filter was dropped. */
  relaxed: boolean;
  exposure: Exposure;
}

export type Resolution =
  | { kind: "one"; entity: EntityInfo }
  | { kind: "ambiguous"; candidates: EntityInfo[] }
  | { kind: "none" };

export type TargetResolution =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "entity"; ref: string; resolution: Resolution }
  | { kind: "area"; ref: string };

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function attrString(attributes: Record<string, unknown>, key: string): string | null {
  const value = attributes[key];
  return typeof value === "string" ? value : null;
}

function isDefaultExposed(state: HaState, hidden: Set<string>): boolean {
  if (hidden.has(state.entity_id)) return false;
  const domain = domainOf(state.entity_id);
  if (DEFAULT_EXPOSED_DOMAINS.has(domain)) return true;
  const deviceClass = attrString(state.attributes, "device_class");
  if (!deviceClass) return false;
  if (domain === "binary_sensor") return DEFAULT_EXPOSED_BINARY_SENSOR_CLASSES.has(deviceClass);
  if (domain === "sensor") return DEFAULT_EXPOSED_SENSOR_CLASSES.has(deviceClass);
  return false;
}

/**
 * The queryable view of the house: states joined to their area and floor, narrowed to
 * the entities the user actually exposed to their assistant.
 */
export class EntityCatalog {
  private readonly states = new Slot<HaState[]>(STATES_TTL_MS);
  private readonly registry = new Slot<{ areas: HaArea[]; hidden: Set<string>; areaOf: Map<string, HaArea> }>(REGISTRY_TTL_MS);
  private readonly exposed = new Slot<{ ids: string[] | null; note: string | null }>(EXPOSURE_TTL_MS);

  constructor(
    private readonly client: HomeAssistantClient,
    private readonly assistant: string,
  ) {}

  /** Called after a service call, so the next read reflects what just changed. */
  invalidateStates(): void {
    this.states.clear();
  }

  invalidateAll(): void {
    this.states.clear();
    this.registry.clear();
    this.exposed.clear();
  }

  private loadStates(): Promise<HaState[]> {
    return this.states.get(() => this.client.getStates());
  }

  private loadRegistry() {
    return this.registry.get(async () => {
      const registry = await this.client.getRegistry();
      const areaOf = new Map<string, HaArea>();
      for (const area of registry.areas) {
        for (const entityId of area.entities) areaOf.set(entityId, area);
      }
      return { areas: registry.areas, hidden: new Set(registry.hidden), areaOf };
    });
  }

  /**
   * The Expose list itself. Cached on its own so that the default-exposure fallback stays
   * computed from current states rather than from whatever states were loaded ten minutes
   * ago; `ids: null` means the list was unusable and `note` says why.
   */
  private loadExposedIds(): Promise<{ ids: string[] | null; note: string | null }> {
    return this.exposed.get(async () => {
      try {
        const ids = await this.client.listExposedEntities(this.assistant);
        if (ids.length > 0) return { ids, note: null };
        return {
          ids: null,
          note:
            "Home Assistant reports no entities exposed to this assistant, so its " +
            "default-exposure rules are in use. Choose them in Settings → Voice assistants → Expose.",
        };
      } catch (err) {
        return {
          ids: null,
          note:
            `Could not read the Expose list (${err instanceof Error ? err.message : String(err)}), ` +
            "so Home Assistant's default-exposure rules are in use. Reading it needs a long-lived " +
            "token belonging to an admin user.",
        };
      }
    });
  }

  async snapshot(): Promise<Snapshot> {
    const [states, registry, exposedList] = await Promise.all([
      this.loadStates(),
      this.loadRegistry(),
      this.loadExposedIds(),
    ]);
    const exposure: Exposure = exposedList.ids
      ? { ids: new Set(exposedList.ids), source: "expose", note: null }
      : {
          ids: new Set(states.filter((s) => isDefaultExposed(s, registry.hidden)).map((s) => s.entity_id)),
          source: "defaults",
          note: exposedList.note,
        };

    const entities = states.map((state): EntityInfo => {
      const area = registry.areaOf.get(state.entity_id) ?? null;
      return {
        entity_id: state.entity_id,
        domain: domainOf(state.entity_id),
        name: attrString(state.attributes, "friendly_name") ?? state.entity_id,
        state: state.state,
        attributes: state.attributes,
        last_changed: state.last_changed,
        areaId: area?.area_id ?? null,
        area: area?.name ?? null,
        floor: area?.floor ?? null,
        exposed: exposure.ids.has(state.entity_id),
      };
    });
    entities.sort((a, b) => a.entity_id.localeCompare(b.entity_id));

    const byId = new Map(entities.map((entity) => [entity.entity_id, entity]));
    const areas: AreaSummary[] = registry.areas.map((area) => {
      const present = area.entities.filter((id) => byId.has(id));
      return {
        area_id: area.area_id,
        name: area.name,
        floor: area.floor,
        total: present.length,
        exposed: present.filter((id) => byId.get(id)!.exposed).length,
      };
    });
    areas.sort((a, b) => a.name.localeCompare(b.name));

    return { entities, byId, areas, exposure };
  }

  async query(query: EntityQuery): Promise<QueryResult> {
    const snapshot = await this.snapshot();
    const limit = query.limit ?? 200;

    const domains = query.domains?.length ? new Set(query.domains.map((d) => d.toLowerCase())) : null;
    const areaTerm = query.area ? normalise(query.area) : null;
    const searchTerm = query.search ? normalise(query.search) : null;
    const stateTerm = query.state?.toLowerCase() ?? null;

    const base = snapshot.entities.filter((entity) => {
      if (domains && !domains.has(entity.domain)) return false;
      if (stateTerm && entity.state.toLowerCase() !== stateTerm) return false;
      if (areaTerm) {
        const haystack = `${normalise(entity.area ?? "")} ${normalise(entity.areaId ?? "")} ${normalise(entity.floor ?? "")}`;
        if (!haystack.includes(areaTerm)) return false;
      }
      if (searchTerm) {
        const haystack = `${normalise(entity.entity_id)} ${normalise(entity.name)}`;
        if (!searchTerm.split(" ").every((token) => haystack.includes(token))) return false;
      }
      return true;
    });

    let relaxed = false;
    let matches = query.includeUnexposed ? base : base.filter((entity) => entity.exposed);
    // A deliberately narrow query that lands on nothing is more useful answered from the
    // full set than answered "none" — automations and scripts are never exposed by default.
    if (matches.length === 0 && base.length > 0 && !query.includeUnexposed) {
      matches = base;
      relaxed = true;
    }

    return {
      matches: matches.slice(0, limit),
      matched: matches.length,
      truncated: matches.length > limit,
      relaxed,
      exposure: snapshot.exposure,
    };
  }

  /**
   * Normalises a service payload into what the REST endpoint expects: `target` unwrapped to
   * the top level (models trained on Home Assistant's YAML routinely nest it, and the REST
   * API does not unwrap it), and entity/area references resolved from names to IDs.
   */
  async resolveServiceData(payload: Record<string, unknown>): Promise<TargetResolution> {
    const data = { ...payload };
    const target = data["target"];
    if (target && typeof target === "object" && !Array.isArray(target)) {
      delete data["target"];
      Object.assign(data, target as Record<string, unknown>);
    }

    const entities = data["entity_id"];
    if (typeof entities === "string" || Array.isArray(entities)) {
      const refs = (Array.isArray(entities) ? entities : [entities]).map(String);
      const resolved: string[] = [];
      for (const ref of refs) {
        const literal = ref.trim().toLowerCase();
        if (LITERAL_TARGETS.has(literal)) {
          resolved.push(literal);
          continue;
        }
        const resolution = await this.resolve(ref);
        if (resolution.kind !== "one") return { kind: "entity", ref, resolution };
        resolved.push(resolution.entity.entity_id);
      }
      data["entity_id"] = Array.isArray(entities) ? resolved : resolved[0];
    }

    const areas = data["area_id"];
    if (typeof areas === "string" || Array.isArray(areas)) {
      const refs = (Array.isArray(areas) ? areas : [areas]).map(String);
      const resolved: string[] = [];
      for (const ref of refs) {
        const ids = await this.resolveAreaIds(ref);
        if (ids.length === 0) return { kind: "area", ref };
        resolved.push(...ids);
      }
      data["area_id"] = resolved;
    }

    return { kind: "ok", data };
  }

  /** Accepts an area_id, an area name or a floor name, and returns the matching area_ids. */
  async resolveAreaIds(ref: string): Promise<string[]> {
    const term = normalise(ref);
    if (!term) return [];
    const { areas } = await this.snapshot();
    const exact = areas.filter((area) => normalise(area.area_id) === term || normalise(area.name) === term);
    if (exact.length > 0) return exact.map((area) => area.area_id);
    return areas
      .filter((area) => normalise(area.floor ?? "") === term)
      .map((area) => area.area_id);
  }

  /** Accepts an entity_id or a friendly name, so callers needn't list entities first. */
  async resolve(ref: string): Promise<Resolution> {
    const snapshot = await this.snapshot();
    const trimmed = ref.trim();
    const exact = snapshot.byId.get(trimmed);
    if (exact) return { kind: "one", entity: exact };

    const term = normalise(trimmed);
    if (!term) return { kind: "none" };

    let best = 0;
    const scored: { entity: EntityInfo; score: number }[] = [];
    for (const entity of snapshot.entities) {
      const name = normalise(entity.name);
      const id = normalise(entity.entity_id);
      let score = 0;
      if (name === term || id === term) score = 100;
      else if (name.startsWith(term)) score = 70;
      else if (name.includes(term) || id.includes(term)) score = 60;
      else if (term.split(" ").every((token) => `${name} ${id}`.includes(token))) score = 50;
      if (score === 0) continue;
      // Exposed entities win ties: they are what the user meant by a spoken name.
      if (entity.exposed) score += 5;
      best = Math.max(best, score);
      scored.push({ entity, score });
    }

    const top = scored.filter((item) => item.score === best).map((item) => item.entity);
    if (top.length === 0) return { kind: "none" };
    if (top.length === 1) return { kind: "one", entity: top[0]! };
    return { kind: "ambiguous", candidates: top.slice(0, MAX_CANDIDATES) };
  }
}
