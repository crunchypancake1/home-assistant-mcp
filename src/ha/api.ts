import type { HaArea, HaHistoryEntry, HaRegistry, HaState } from "../types";

export class HaApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "HaApiError";
  }
}

/**
 * Areas, their floor, their entities and the hidden-entity set in one render —
 * none of it is reachable from `/api/states`, and Jinja has no comprehensions,
 * so the lists are built with `namespace` accumulators.
 */
const REGISTRY_TEMPLATE =
  '{%- set ns = namespace(areas=[], hidden=[]) -%}' +
  '{%- for a in areas() -%}' +
  '{%- set ns.areas = ns.areas + [{"area_id": a, "name": area_name(a), "floor": floor_name(a), "entities": area_entities(a) | list}] -%}' +
  '{%- endfor -%}' +
  '{%- for s in states -%}' +
  '{%- if is_hidden_entity(s.entity_id) -%}{%- set ns.hidden = ns.hidden + [s.entity_id] -%}{%- endif -%}' +
  '{%- endfor -%}' +
  '{{ {"areas": ns.areas, "hidden": ns.hidden} | tojson }}';

const WS_TIMEOUT_MS = 8_000;

/** Thin wrapper around the Home Assistant REST and WebSocket APIs. Holds no cache. */
export class HomeAssistantClient {
  private readonly origin: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.origin = baseUrl.replace(/\/$/, "");
  }

  private send(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.origin}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });
  }

  private async fail(res: Response, path: string): Promise<never> {
    // HA puts the actionable part ("not a valid value for dictionary value
    // @ data['brightness']") in the body, not the status line.
    const detail = (await res.text().catch(() => "")).slice(0, 500).trim();
    throw new HaApiError(
      res.status,
      path,
      `HA API error: ${res.status} ${res.statusText} on ${path}${detail ? ` — ${detail}` : ""}`,
    );
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.send(path, init);
    if (!res.ok) await this.fail(res, path);
    return res;
  }

  async getStates(): Promise<HaState[]> {
    const res = await this.request("/api/states");
    return res.json() as Promise<HaState[]>;
  }

  async getEntityState(entityId: string): Promise<HaState | null> {
    const path = `/api/states/${encodeURIComponent(entityId)}`;
    const res = await this.send(path);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, path);
    return res.json() as Promise<HaState>;
  }

  async callService(
    domain: string,
    service: string,
    serviceData: Record<string, unknown> = {},
  ): Promise<HaState[]> {
    const path = `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
    const res = await this.request(path, { method: "POST", body: JSON.stringify(serviceData) });
    const body = await res.json();
    return Array.isArray(body) ? (body as HaState[]) : [];
  }

  /** One request covers every entity; the response is one series per entity, in request order. */
  async getHistory(entityIds: string[], hoursBack: number): Promise<HaHistoryEntry[][]> {
    const end = new Date();
    const start = new Date(end.getTime() - hoursBack * 60 * 60 * 1000);
    const filter = encodeURIComponent(entityIds.join(","));
    const path =
      `/api/history/period/${encodeURIComponent(start.toISOString())}` +
      `?filter_entity_id=${filter}&end_time=${encodeURIComponent(end.toISOString())}` +
      `&minimal_response=true&no_attributes=true`;
    const res = await this.request(path);
    const data = (await res.json()) as HaHistoryEntry[][];
    return Array.isArray(data) ? data : [];
  }

  async getRegistry(): Promise<HaRegistry> {
    const parsed = await this.renderTemplate(REGISTRY_TEMPLATE);
    const raw = parsed as Partial<HaRegistry>;
    const areas = Array.isArray(raw.areas) ? raw.areas : [];
    return {
      areas: areas.map((a): HaArea => ({
        area_id: a.area_id,
        name: a.name ?? a.area_id,
        floor: a.floor ?? null,
        entities: Array.isArray(a.entities) ? a.entities : [],
      })),
      hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
    };
  }

  private async renderTemplate(template: string): Promise<unknown> {
    const res = await this.request("/api/template", {
      method: "POST",
      body: JSON.stringify({ template }),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new HaApiError(200, "/api/template", `HA template error: ${text.slice(0, 300)}`);
    }
  }

  /**
   * Entity IDs the user has exposed to `assistant` in Settings → Voice assistants.
   * Only the WebSocket API can answer this — there is no REST equivalent — and the
   * command is admin-only, so a non-admin token fails here and the caller falls back.
   */
  async listExposedEntities(assistant: string): Promise<string[]> {
    const res = await fetch(`${this.origin}/api/websocket`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) {
      throw new HaApiError(res.status, "/api/websocket", `WebSocket handshake refused (HTTP ${res.status})`);
    }
    ws.accept();

    return new Promise<string[]>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close(1000, "done");
        } catch {
          // Already closing; nothing to clean up.
        }
        fn();
      };
      const fail = (message: string) =>
        finish(() => reject(new HaApiError(0, "/api/websocket", message)));

      const timer = setTimeout(() => fail(`timed out after ${WS_TIMEOUT_MS}ms`), WS_TIMEOUT_MS);

      ws.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        switch (msg["type"]) {
          case "auth_required":
            ws.send(JSON.stringify({ type: "auth", access_token: this.token }));
            return;
          case "auth_ok":
            ws.send(JSON.stringify({ id: 1, type: "homeassistant/expose_entity/list" }));
            return;
          case "auth_invalid":
            fail("WebSocket auth rejected — HA_TOKEN is not valid for the WebSocket API");
            return;
          case "result": {
            if (msg["success"] !== true) {
              const err = msg["error"] as { message?: string } | undefined;
              fail(`expose_entity/list failed: ${err?.message ?? "unknown error"}`);
              return;
            }
            const result = msg["result"] as { exposed_entities?: Record<string, Record<string, boolean>> };
            const exposed = result?.exposed_entities ?? {};
            const ids = Object.entries(exposed)
              .filter(([, assistants]) => assistants?.[assistant] === true)
              .map(([entityId]) => entityId);
            finish(() => resolve(ids));
          }
        }
      });

      ws.addEventListener("error", () => fail("WebSocket error"));
      ws.addEventListener("close", () => fail("WebSocket closed before a result arrived"));
    });
  }
}
