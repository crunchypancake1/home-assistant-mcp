import { describe, it, expect, vi, beforeEach } from "vitest";
import { HomeAssistantClient } from "../src/ha/api";
import type { HaState } from "../src/types";

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
});
