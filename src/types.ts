export interface Env {
  HA_MCP: DurableObjectNamespace;
  HA_URL: string;
  HA_TOKEN: string;
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
