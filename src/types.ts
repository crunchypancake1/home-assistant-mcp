export interface Env {
  HA_MCP: DurableObjectNamespace;
  HA_URL: string;
  HA_TOKEN: SecretsStoreSecret;
  /** Assistant key whose Expose list defines the visible entity set. */
  HA_ASSISTANT?: string;
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
  floor: string | null;
  entities: string[];
}

/** Registry facts that `/api/states` doesn't carry, fetched in one template call. */
export interface HaRegistry {
  areas: HaArea[];
  hidden: string[];
}

export interface HaHistoryEntry {
  entity_id?: string;
  state: string;
  last_changed?: string;
  last_updated?: string;
}
