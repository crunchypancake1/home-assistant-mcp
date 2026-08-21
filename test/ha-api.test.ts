import { describe, it, expect, vi, beforeEach } from "vitest";
import { HomeAssistantClient } from "../src/ha/api";
import type { HaState, HaHistoryEntry } from "../src/types";

const BASE_URL = "https://ha.example.com";
const TOKEN = "test-token";

function makeState(entity_id: string, state = "on"): HaState {
  return {
    entity_id,
    state,
    attributes: {},
    last_changed: "2026-01-01T00:00:00+00:00",
    last_updated: "2026-01-01T00:00:00+00:00",
  };
}

describe("HomeAssistantClient", () => {
  let client: HomeAssistantClient;

  beforeEach(() => {
    client = new HomeAssistantClient(BASE_URL, TOKEN);
    vi.restoreAllMocks();
  });

  describe("getStates", () => {
    it("fetches all states with bearer token", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify([makeState("light.living"), makeState("switch.fan")]),
          { status: 200 }
        )
      );

      const states = await client.getStates();

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://ha.example.com/api/states");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-token");
      expect(states).toHaveLength(2);
    });

    it("filters by domain when provided", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            makeState("light.living"),
            makeState("switch.fan"),
            makeState("light.bedroom"),
          ]),
          { status: 200 }
        )
      );

      const states = await client.getStates("light");
      expect(states).toHaveLength(2);
      expect(states.every((s) => s.entity_id.startsWith("light."))).toBe(true);
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Forbidden", { status: 403 })
      );
      await expect(client.getStates()).rejects.toThrow("HA API error: 403");
    });

    it("excludes noisy domains (e.g. update) when no domain filter is given", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            makeState("light.living"),
            makeState("update.hacs"),
            makeState("update.frontend"),
          ]),
          { status: 200 }
        )
      );

      const states = await client.getStates();
      expect(states).toHaveLength(1);
      expect(states[0]?.entity_id).toBe("light.living");
    });

    it("still returns update entities when explicitly requested", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify([makeState("light.living"), makeState("update.hacs")]),
          { status: 200 }
        )
      );

      const states = await client.getStates("update");
      expect(states).toHaveLength(1);
      expect(states[0]?.entity_id).toBe("update.hacs");
    });
  });

  describe("getEntityState", () => {
    it("returns state for a valid entity", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(makeState("light.living")), { status: 200 })
      );

      const state = await client.getEntityState("light.living");
      expect(state).not.toBeNull();
      expect(state?.entity_id).toBe("light.living");
    });

    it("returns null when entity is not found (404)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Entity not found", { status: 404 })
      );

      const state = await client.getEntityState("light.nonexistent");
      expect(state).toBeNull();
    });

    it("throws on non-404 errors", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 })
      );
      await expect(client.getEntityState("light.living")).rejects.toThrow("HA API error: 401");
    });

    it("encodes special characters in entityId to prevent path traversal", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Not Found", { status: 404 })
      );

      await client.getEntityState("../config");

      const [url] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("%2F");
      expect(url).not.toContain("../");
    });
  });

  describe("callService", () => {
    it("POSTs to the correct endpoint with service data", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([makeState("light.living")]), { status: 200 })
      );

      const result = await client.callService("light", "turn_on", {
        entity_id: "light.living",
        brightness: 128,
      });

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://ha.example.com/api/services/light/turn_on");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ entity_id: "light.living", brightness: 128 });
      expect(result).toHaveLength(1);
    });

    it("returns empty array when HA returns no affected entities", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200 })
      );

      const result = await client.callService("homeassistant", "reload_all", {});
      expect(result).toHaveLength(0);
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Service not found", { status: 404 })
      );
      await expect(client.callService("light", "nonexistent", {})).rejects.toThrow("HA API error: 404");
    });

    it("encodes special characters in domain and service to prevent path traversal", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200 })
      );

      await client.callService("../config", "auth/providers", {});

      const [url] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("%2F");
      expect(url).not.toContain("../");
    });
  });

  describe("listAreas", () => {
    it("POSTs the template and parses the rendered JSON", async () => {
      const rendered = JSON.stringify([
        { area_id: "living_room", name: "Living Room" },
        { area_id: "bedroom", name: "Bedroom" },
      ]);
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(rendered, { status: 200 })
      );

      const areas = await client.listAreas();

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://ha.example.com/api/template");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toHaveProperty("template");
      expect(typeof body.template).toBe("string");
      expect(areas).toHaveLength(2);
      expect(areas[0]?.area_id).toBe("living_room");
      expect(areas[0]?.name).toBe("Living Room");
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Error", { status: 500 })
      );
      await expect(client.listAreas()).rejects.toThrow("HA API error: 500");
    });
  });

  describe("getEntityHistory", () => {
    it("fetches history for an entity with correct URL", async () => {
      const entry: HaHistoryEntry = {
        entity_id: "light.living",
        state: "on",
        last_changed: "2026-01-01T00:00:00+00:00",
      };
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([[entry]]), { status: 200 })
      );

      const history = await client.getEntityHistory("light.living", 24);

      const [url] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/history/period/");
      expect(url).toContain("filter_entity_id=light.living");
      expect(url).toContain("minimal_response=true");
      expect(url).toContain("no_attributes=true");
      expect(url).toContain("end_time=");
      expect(history).toHaveLength(1);
      expect(history[0]?.state).toBe("on");
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Error", { status: 500 })
      );
      await expect(client.getEntityHistory("light.living", 1)).rejects.toThrow("HA API error: 500");
    });
  });

  describe("getEntitiesByArea", () => {
    it("POSTs a template and returns entity IDs for the given area", async () => {
      const rendered = JSON.stringify(["light.bedroom_lamp", "switch.bedroom_fan"]);
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(rendered, { status: 200 })
      );

      const entities = await client.getEntitiesByArea("bedroom");

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://ha.example.com/api/template");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.template).toContain("area_entities('bedroom')");
      expect(entities).toEqual(["light.bedroom_lamp", "switch.bedroom_fan"]);
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Error", { status: 500 })
      );
      await expect(client.getEntitiesByArea("bedroom")).rejects.toThrow("HA API error: 500");
    });

    it("throws on invalid template response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Template error: unknown area", { status: 200 })
      );
      await expect(client.getEntitiesByArea("no_such_area")).rejects.toThrow("HA template error");
    });

    it("escapes single quotes in the area ID to prevent template injection", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("[]", { status: 200 })
      );
      await client.getEntitiesByArea("it's");
      const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.template).toContain("it\\'s");
      expect(body.template).not.toContain("it's");
    });
  });
});
