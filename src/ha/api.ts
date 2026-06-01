import type { HaArea, HaState } from "../types";

export class HomeAssistantClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async doFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  async getStates(domain?: string): Promise<HaState[]> {
    const res = await this.doFetch("/api/states");
    if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText}`);
    const states = await res.json() as HaState[];
    if (!domain) return states;
    return states.filter((s) => s.entity_id.startsWith(`${domain}.`));
  }

  async getEntityState(entityId: string): Promise<HaState | null> {
    const res = await this.doFetch(`/api/states/${entityId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText}`);
    return res.json() as Promise<HaState>;
  }

  async callService(
    domain: string,
    service: string,
    serviceData: Record<string, unknown> = {},
  ): Promise<HaState[]> {
    const res = await this.doFetch(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(serviceData),
    });
    if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText}`);
    return res.json() as Promise<HaState[]>;
  }

  async listAreas(): Promise<HaArea[]> {
    const template = `{{ [{"area_id": a, "name": area_name(a)} for a in areas()] | tojson }}`;
    const res = await this.doFetch("/api/template", {
      method: "POST",
      body: JSON.stringify({ template }),
    });
    if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText}`);
    const text = await res.text();
    return JSON.parse(text) as HaArea[];
  }
}
