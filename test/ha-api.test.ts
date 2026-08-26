import { describe, it, expect, vi, beforeEach } from "vitest";
import { HaApiError, HomeAssistantClient } from "../src/ha/api";
import type { HaState } from "../src/types";

const BASE_URL = "https://ha.example.com";
const TOKEN = "test-token";

function makeState(entity_id: string, state = "on", attributes: Record<string, unknown> = {}): HaState {
  return {
    entity_id,
    state,
    attributes,
    last_changed: "2026-01-01T00:00:00+00:00",
    last_updated: "2026-01-01T00:00:00+00:00",
  };
}

/** Drives the Home Assistant WebSocket handshake against the client's listeners. */
class FakeWebSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(private readonly onCommand: (msg: Record<string, unknown>) => unknown) {}

  accept(): void {
    this.deliver({ type: "auth_required" });
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(fn);
    this.listeners.set(type, bucket);
  }

  send(data: string): void {
    this.sent.push(data);
    const reply = this.onCommand(JSON.parse(data) as Record<string, unknown>);
    if (reply !== undefined) this.deliver(reply);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  private deliver(payload: unknown): void {
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(payload) }));
  }
}

function mockSocket(ws: FakeWebSocket) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce({ status: 101, webSocket: ws } as unknown as Response);
}

describe("HomeAssistantClient", () => {
  let client: HomeAssistantClient;

  beforeEach(() => {
    client = new HomeAssistantClient(BASE_URL, TOKEN);
    vi.restoreAllMocks();
  });

  describe("getStates", () => {
    it("fetches every state with the bearer token", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify([makeState("light.living"), makeState("update.hacs")]), { status: 200 }),
        );

      const states = await client.getStates();

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://ha.example.com/api/states");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-token");
      // Narrowing is the catalog's job — the client returns what HA returned.
      expect(states).toHaveLength(2);
    });

    it("puts HA's response body into the error message", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("401: Unauthorized", { status: 401 }),
      );
      await expect(client.getStates()).rejects.toThrow(/401 .*401: Unauthorized/);
    });

    it("throws HaApiError carrying the status", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("nope", { status: 403 }));
      await expect(client.getStates()).rejects.toBeInstanceOf(HaApiError);
    });
  });

  describe("getEntityState", () => {
    it("returns null for a missing entity", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 404 }));
      expect(await client.getEntityState("light.nope")).toBeNull();
    });

    it("encodes the entity id", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify(makeState("light.a")), { status: 200 }));
      await client.getEntityState("light.a b");
      expect(spy.mock.calls[0]![0]).toBe("https://ha.example.com/api/states/light.a%20b");
    });
  });

  describe("callService", () => {
    it("posts the payload and returns the affected states", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify([makeState("light.a")]), { status: 200 }));

      const affected = await client.callService("light", "turn_on", { entity_id: "light.a" });

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://ha.example.com/api/services/light/turn_on");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ entity_id: "light.a" });
      expect(affected).toHaveLength(1);
    });

    it("tolerates a non-array response body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      expect(await client.callService("script", "turn_on")).toEqual([]);
    });
  });

  describe("getHistory", () => {
    it("asks for every entity in one minimal-response request", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify([[{ state: "on", last_changed: "x" }]]), { status: 200 }));

      const series = await client.getHistory(["light.a", "light.b"], 12);

      const url = spy.mock.calls[0]![0] as string;
      expect(url).toContain("filter_entity_id=light.a%2Clight.b");
      expect(url).toContain("minimal_response=true");
      expect(url).toContain("no_attributes=true");
      expect(series).toHaveLength(1);
    });
  });

  describe("getRegistry", () => {
    it("renders one template and normalises the result", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            areas: [
              { area_id: "kitchen", name: "Kitchen", floor: "Ground", entities: ["light.k"] },
              { area_id: "loft", name: "Loft", floor: null },
            ],
            hidden: ["sensor.rssi"],
          }),
          { status: 200 },
        ),
      );

      const registry = await client.getRegistry();

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://ha.example.com/api/template");
      // Jinja has no list comprehensions, so the template must build with namespace/for.
      const template = (JSON.parse(init.body as string) as { template: string }).template;
      expect(template).toContain("namespace(");
      expect(template).not.toMatch(/\[.*for .* in areas\(\)\]/);
      expect(registry.areas[1]).toEqual({ area_id: "loft", name: "Loft", floor: null, entities: [] });
      expect(registry.hidden).toEqual(["sensor.rssi"]);
    });

    it("reports a template rendering error rather than crashing on the body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("UndefinedError: 'areas' is undefined", { status: 200 }),
      );
      await expect(client.getRegistry()).rejects.toThrow(/HA template error/);
    });
  });

  describe("listExposedEntities", () => {
    it("authenticates then returns the entities exposed to the assistant", async () => {
      const ws = new FakeWebSocket((msg) => {
        if (msg["type"] === "auth") return { type: "auth_ok" };
        return {
          id: msg["id"],
          type: "result",
          success: true,
          result: {
            exposed_entities: {
              "light.kitchen": { conversation: true, "cloud.alexa": false },
              "sensor.rssi": { "cloud.alexa": true },
              "light.loft": { conversation: false },
            },
          },
        };
      });
      mockSocket(ws);

      const exposed = await client.listExposedEntities("conversation");

      expect(exposed).toEqual(["light.kitchen"]);
      expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "auth", access_token: TOKEN });
      expect(JSON.parse(ws.sent[1]!)).toEqual({ id: 1, type: "homeassistant/expose_entity/list" });
      expect(ws.closed).toBe(true);
    });

    it("rejects when the command is refused", async () => {
      mockSocket(
        new FakeWebSocket((msg) =>
          msg["type"] === "auth"
            ? { type: "auth_ok" }
            : { id: msg["id"], type: "result", success: false, error: { message: "unauthorized" } },
        ),
      );
      await expect(client.listExposedEntities("conversation")).rejects.toThrow(/unauthorized/);
    });

    it("rejects when auth is refused", async () => {
      mockSocket(new FakeWebSocket(() => ({ type: "auth_invalid" })));
      await expect(client.listExposedEntities("conversation")).rejects.toThrow(/auth rejected/);
    });

    it("rejects when the upgrade is refused", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        { status: 400, webSocket: null } as unknown as Response,
      );
      await expect(client.listExposedEntities("conversation")).rejects.toThrow(/handshake refused/);
    });
  });
});
