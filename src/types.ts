export interface Env {
  HA_MCP: DurableObjectNamespace;
  HA_URL: string;
  HA_TOKEN: SecretsStoreSecret;
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HaArea {
  area_id: string;
  name: string;
}

export interface HaHistoryEntry {
  entity_id?: string;
  state: string;
  last_changed: string;
}
