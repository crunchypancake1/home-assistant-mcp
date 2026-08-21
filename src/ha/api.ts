import type { HaArea, HaHistoryEntry, HaState } from "../types";

/**
 * Domains that are pure diagnostic noise for a voice assistant — never
 * something you'd ask to control or check by voice — so they're dropped from
 * an unfiltered getStates() call. `update` entities exist only to say "a new
 * firmware/software version is available"; every instance costs tokens in the
 * tool_result (uncached, unlike the tool schemas) for zero practical value.
 * Still reachable by requesting the domain explicitly.
 */
const NOISY_DOMAINS = ["update"];

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
        ...(init.headers ?? {}),
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });
  }

  async getStates(domain?: string): Promise<HaState[]> {
    const res = await this.doFetch("/api/states");
    if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText} on /api/states`);
    const states = await res.json() as HaState[];
    if (domain) return states.filter((s) => s.entity_id.startsWith(`${domain}.`));
    return states.filter(
      (s) => !NOISY_DOMAINS.some((noisy) => s.entity_id.startsWith(`${noisy}.`)),
    );
  }

  async getEntityState(entityId: string): Promise<HaState | null> {
    const encodedId = encodeURIComponent(entityId);
    const res = await this.doFetch(`/api/states/${encodedId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText} on /api/states/${encodedId}`);
    return res.json() as Promise<HaState>;
  }

  async callService(
    domain: string,
    service: string,
    serviceData: Record<string, unknown> = {},
  ): Promise<HaState[]> {
    const encodedDomain = encodeURIComponent(domain);
    const encodedService = encodeURIComponent(service);
    const res = await this.doFetch(`/api/services/${encodedDomain}/${encodedService}`, {
      method: "POST",
      body: JSON.stringify(serviceData),
    });
    if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText} on /api/services/${encodedDomain}/${encodedService}`);
    return res.json() as Promise<HaState[]>;
  }

  async getEntityHistory(entityId: string, hoursBack = 24): Promise<HaHistoryEntry[]> {
    const end = new Date();
    const start = new Date(end.getTime() - hoursBack * 60 * 60 * 1000);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const encodedId = encodeURIComponent(entityId);
    const path = `/api/history/period/${encodeURIComponent(startIso)}?filter_entity_id=${encodedId}&end_time=${encodeURIComponent(endIso)}&minimal_response=true&no_attributes=true`;
    const res = await this.doFetch(path);
    if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText} on /api/history/period`);
    const data = await res.json() as HaHistoryEntry[][];
    return data[0] ?? [];
  }

  async getEntitiesByArea(areaId: string): Promise<string[]> {
    const template = `{{ area_entities('${areaId.replace(/'/g, "\\'")}') | list | tojson }}`;
    const res = await this.doFetch("/api/template", {
      method: "POST",
      body: JSON.stringify({ template }),
    });
    if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText} on /api/template`);
    const text = await res.text();
    try {
      return JSON.parse(text) as string[];
    } catch {
      throw new Error(`HA template error: ${text}`);
    }
  }

  async listAreas(): Promise<HaArea[]> {
    const template = `{{ [{"area_id": a, "name": area_name(a)} for a in areas()] | tojson }}`;
    const res = await this.doFetch("/api/template", {
      method: "POST",
      body: JSON.stringify({ template }),
    });
    if (!res.ok) throw new Error(`HA API error: ${res.status} ${res.statusText} on /api/template`);
    const text = await res.text();
    try {
      return JSON.parse(text) as HaArea[];
    } catch {
      throw new Error(`HA template error: ${text}`);
    }
  }
}
