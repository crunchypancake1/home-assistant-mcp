import { describe, it, expect, vi } from "vitest";
import { EntityCatalog } from "../src/ha/catalog";
import type { HomeAssistantClient } from "../src/ha/api";
import type { HaRegistry, HaState } from "../src/types";

function state(entity_id: string, s = "on", attributes: Record<string, unknown> = {}): HaState {
  return {
    entity_id,
    state: s,
    attributes,
    last_changed: "2026-01-01T00:00:00+00:00",
    last_updated: "2026-01-01T00:00:00+00:00",
  };
}

const STATES: HaState[] = [
  state("light.kitchen_ceiling", "on", { friendly_name: "Kitchen Ceiling", brightness: 255 }),
  state("light.loft_lamp", "off", { friendly_name: "Loft Lamp" }),
  state("switch.kettle", "off", { friendly_name: "Kettle" }),
  state("sensor.kitchen_temp", "21.4", { friendly_name: "Kitchen Temperature", device_class: "temperature", unit_of_measurement: "°C" }),
  state("sensor.kitchen_rssi", "-62", { friendly_name: "Kitchen Signal", device_class: "signal_strength" }),
  state("binary_sensor.front_door", "off", { friendly_name: "Front Door", device_class: "door" }),
  state("update.hacs", "on", { friendly_name: "HACS Update" }),
  state("automation.good_morning", "on", { friendly_name: "Good Morning", last_triggered: "2026-01-01T06:00:00+00:00" }),
];

const REGISTRY: HaRegistry = {
  areas: [
    {
      area_id: "kitchen",
      name: "Kitchen",
      floor: "Ground",
      entities: ["light.kitchen_ceiling", "switch.kettle", "sensor.kitchen_temp", "sensor.kitchen_rssi"],
    },
    { area_id: "loft", name: "Loft", floor: "Upstairs", entities: ["light.loft_lamp"] },
  ],
  hidden: ["sensor.kitchen_rssi"],
};

interface Stub {
  catalog: EntityCatalog;
  getStates: ReturnType<typeof vi.fn>;
  getRegistry: ReturnType<typeof vi.fn>;
  listExposedEntities: ReturnType<typeof vi.fn>;
}

function stubCatalog(exposed: string[] | Error = ["light.kitchen_ceiling", "light.loft_lamp", "switch.kettle"]): Stub {
  const getStates = vi.fn(async () => STATES);
  const getRegistry = vi.fn(async () => REGISTRY);
  const listExposedEntities = vi.fn(async () => {
    if (exposed instanceof Error) throw exposed;
    return exposed;
  });
  const client = { getStates, getRegistry, listExposedEntities } as unknown as HomeAssistantClient;
  return { catalog: new EntityCatalog(client, "conversation"), getStates, getRegistry, listExposedEntities };
}

describe("EntityCatalog.snapshot", () => {
  it("joins states to their area and floor", async () => {
    const { catalog } = stubCatalog();
    const snapshot = await catalog.snapshot();
    expect(snapshot.byId.get("light.kitchen_ceiling")).toMatchObject({
      name: "Kitchen Ceiling",
      area: "Kitchen",
      floor: "Ground",
      areaId: "kitchen",
      exposed: true,
    });
    expect(snapshot.byId.get("update.hacs")).toMatchObject({ area: null, exposed: false });
  });

  it("counts exposed entities per area", async () => {
    const { catalog } = stubCatalog();
    const snapshot = await catalog.snapshot();
    expect(snapshot.areas).toEqual([
      { area_id: "kitchen", name: "Kitchen", floor: "Ground", total: 4, exposed: 2 },
      { area_id: "loft", name: "Loft", floor: "Upstairs", total: 1, exposed: 1 },
    ]);
  });
});

describe("EntityCatalog exposure", () => {
  it("uses the Expose list when Home Assistant answers", async () => {
    const { catalog } = stubCatalog();
    const snapshot = await catalog.snapshot();
    expect(snapshot.exposure.source).toBe("expose");
    expect(snapshot.exposure.note).toBeNull();
    expect(snapshot.byId.get("sensor.kitchen_temp")!.exposed).toBe(false);
  });

  it("falls back to HA's default-exposure rules when the Expose list is unreachable", async () => {
    const { catalog } = stubCatalog(new Error("not an admin"));
    const snapshot = await catalog.snapshot();

    expect(snapshot.exposure.source).toBe("defaults");
    expect(snapshot.exposure.note).toContain("not an admin");
    const exposed = [...snapshot.exposure.ids].sort();
    expect(exposed).toEqual([
      "binary_sensor.front_door",
      "light.kitchen_ceiling",
      "light.loft_lamp",
      "sensor.kitchen_temp",
      "switch.kettle",
    ]);
    // Hidden entities and update notices stay out even in the fallback.
    expect(exposed).not.toContain("sensor.kitchen_rssi");
    expect(exposed).not.toContain("update.hacs");
  });

  it("falls back when the Expose list is empty rather than reporting an empty house", async () => {
    const { catalog } = stubCatalog([]);
    const snapshot = await catalog.snapshot();
    expect(snapshot.exposure.source).toBe("defaults");
    expect(snapshot.exposure.ids.size).toBeGreaterThan(0);
  });
});

describe("EntityCatalog.query", () => {
  it("returns only exposed entities by default", async () => {
    const { catalog } = stubCatalog();
    const result = await catalog.query({});
    expect(result.matches.map((e) => e.entity_id)).toEqual([
      "light.kitchen_ceiling",
      "light.loft_lamp",
      "switch.kettle",
    ]);
    expect(result.relaxed).toBe(false);
  });

  it("filters by domain, area, state and search", async () => {
    const { catalog } = stubCatalog();
    expect((await catalog.query({ domains: ["light"] })).matches).toHaveLength(2);
    expect((await catalog.query({ area: "kitchen" })).matches.map((e) => e.entity_id)).toEqual([
      "light.kitchen_ceiling",
      "switch.kettle",
    ]);
    expect((await catalog.query({ area: "upstairs" })).matches.map((e) => e.entity_id)).toEqual(["light.loft_lamp"]);
    expect((await catalog.query({ state: "on" })).matches.map((e) => e.entity_id)).toEqual(["light.kitchen_ceiling"]);
    expect((await catalog.query({ search: "loft lamp" })).matches.map((e) => e.entity_id)).toEqual(["light.loft_lamp"]);
  });

  it("widens to unexposed entities when a narrow filter matches nothing exposed", async () => {
    const { catalog } = stubCatalog();
    const result = await catalog.query({ domains: ["automation"] });
    expect(result.relaxed).toBe(true);
    expect(result.matches.map((e) => e.entity_id)).toEqual(["automation.good_morning"]);
  });

  it("does not widen when nothing matches at all", async () => {
    const { catalog } = stubCatalog();
    const result = await catalog.query({ domains: ["vacuum"] });
    expect(result.relaxed).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  it("reports the pre-limit count when truncating", async () => {
    const { catalog } = stubCatalog();
    const result = await catalog.query({ limit: 1 });
    expect(result.matches).toHaveLength(1);
    expect(result.matched).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("includes unexposed entities on request", async () => {
    const { catalog } = stubCatalog();
    const result = await catalog.query({ includeUnexposed: true });
    expect(result.matches).toHaveLength(STATES.length);
  });
});

describe("EntityCatalog caching", () => {
  it("serves repeat reads in a turn from one request each", async () => {
    const { catalog, getStates, getRegistry, listExposedEntities } = stubCatalog();
    await catalog.query({});
    await catalog.query({ domains: ["light"] });
    await catalog.snapshot();
    expect(getStates).toHaveBeenCalledTimes(1);
    expect(getRegistry).toHaveBeenCalledTimes(1);
    expect(listExposedEntities).toHaveBeenCalledTimes(1);
  });

  it("re-reads states after a service call but keeps the registry", async () => {
    const { catalog, getStates, getRegistry } = stubCatalog();
    await catalog.snapshot();
    catalog.invalidateStates();
    await catalog.snapshot();
    expect(getStates).toHaveBeenCalledTimes(2);
    expect(getRegistry).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed read", async () => {
    const getStates = vi
      .fn<() => Promise<HaState[]>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(STATES);
    const client = {
      getStates,
      getRegistry: async () => REGISTRY,
      listExposedEntities: async () => ["light.loft_lamp"],
    } as unknown as HomeAssistantClient;
    const catalog = new EntityCatalog(client, "conversation");

    await expect(catalog.snapshot()).rejects.toThrow("boom");
    await expect(catalog.snapshot()).resolves.toBeDefined();
    expect(getStates).toHaveBeenCalledTimes(2);
  });
});

describe("EntityCatalog.resolveAreaIds", () => {
  it("matches an area_id, an area name and a floor name", async () => {
    const { catalog } = stubCatalog();
    expect(await catalog.resolveAreaIds("kitchen")).toEqual(["kitchen"]);
    expect(await catalog.resolveAreaIds("Kitchen")).toEqual(["kitchen"]);
    expect(await catalog.resolveAreaIds("Upstairs")).toEqual(["loft"]);
  });

  it("returns nothing for an unknown area", async () => {
    const { catalog } = stubCatalog();
    expect(await catalog.resolveAreaIds("garage")).toEqual([]);
  });
});

describe("EntityCatalog.resolveServiceData", () => {
  it("resolves a friendly name to an entity_id", async () => {
    const { catalog } = stubCatalog();
    const result = await catalog.resolveServiceData({ entity_id: "kitchen ceiling", brightness_pct: 50 });
    expect(result).toEqual({ kind: "ok", data: { entity_id: "light.kitchen_ceiling", brightness_pct: 50 } });
  });

  it("passes HA's literal targets through untouched", async () => {
    const { catalog } = stubCatalog();
    // "all" would otherwise fuzzy-match any entity whose name contains it.
    expect(await catalog.resolveServiceData({ entity_id: "all" })).toEqual({
      kind: "ok",
      data: { entity_id: "all" },
    });
  });

  it("unwraps a nested target, which the REST API does not accept", async () => {
    const { catalog } = stubCatalog();
    const result = await catalog.resolveServiceData({
      target: { entity_id: ["kitchen ceiling", "switch.kettle"] },
      transition: 2,
    });
    expect(result).toEqual({
      kind: "ok",
      data: { entity_id: ["light.kitchen_ceiling", "switch.kettle"], transition: 2 },
    });
  });

  it("resolves an area name to its area_id", async () => {
    const { catalog } = stubCatalog();
    expect(await catalog.resolveServiceData({ area_id: "Kitchen" })).toEqual({
      kind: "ok",
      data: { area_id: ["kitchen"] },
    });
  });

  it("reports the offending reference when an entity cannot be resolved", async () => {
    const { catalog } = stubCatalog();
    const result = await catalog.resolveServiceData({ entity_id: "garden shed heater" });
    expect(result).toMatchObject({ kind: "entity", ref: "garden shed heater", resolution: { kind: "none" } });
  });

  it("reports the offending reference when an area cannot be resolved", async () => {
    const { catalog } = stubCatalog();
    expect(await catalog.resolveServiceData({ area_id: "garage" })).toEqual({ kind: "area", ref: "garage" });
  });

  it("leaves a payload with no targeting alone", async () => {
    const { catalog } = stubCatalog();
    expect(await catalog.resolveServiceData({ message: "hello" })).toEqual({
      kind: "ok",
      data: { message: "hello" },
    });
  });
});

describe("EntityCatalog.resolve", () => {
  it("takes an entity_id verbatim", async () => {
    const { catalog } = stubCatalog();
    await expect(catalog.resolve("switch.kettle")).resolves.toMatchObject({ kind: "one" });
  });

  it("resolves a spoken friendly name", async () => {
    const { catalog } = stubCatalog();
    const resolution = await catalog.resolve("kitchen ceiling");
    expect(resolution).toMatchObject({ kind: "one", entity: { entity_id: "light.kitchen_ceiling" } });
  });

  it("reports candidates when a name is ambiguous", async () => {
    const { catalog } = stubCatalog();
    const resolution = await catalog.resolve("light");
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous") {
      expect(resolution.candidates.map((c) => c.entity_id)).toEqual([
        "light.kitchen_ceiling",
        "light.loft_lamp",
      ]);
    }
  });

  it("lets an exposed entity settle a tie an unexposed one would otherwise share", async () => {
    const { catalog } = stubCatalog();
    // "kitchen" prefixes the ceiling light, the temperature sensor and the signal sensor.
    const resolution = await catalog.resolve("kitchen");
    expect(resolution).toMatchObject({ kind: "one", entity: { entity_id: "light.kitchen_ceiling" } });
  });

  it("prefers an exposed entity over an unexposed one scoring the same", async () => {
    const { catalog } = stubCatalog(["light.kitchen_ceiling"]);
    const resolution = await catalog.resolve("kitchen ceiling");
    expect(resolution).toMatchObject({ kind: "one", entity: { entity_id: "light.kitchen_ceiling" } });
  });

  it("returns none for a name nothing matches", async () => {
    const { catalog } = stubCatalog();
    expect((await catalog.resolve("garden shed heater")).kind).toBe("none");
  });
});
