import type { HaHistoryEntry } from "../types";

/** Attributes worth putting in a list line, per domain. Everything else needs get_entity_state. */
const LISTED_ATTRS: Record<string, string[]> = {
  alarm_control_panel: ["changed_by"],
  automation: ["last_triggered", "current"],
  binary_sensor: ["device_class"],
  button: ["device_class"],
  climate: ["current_temperature", "temperature", "hvac_action", "preset_mode"],
  cover: ["device_class", "current_position", "current_tilt_position"],
  fan: ["percentage", "preset_mode"],
  humidifier: ["current_humidity", "humidity"],
  light: ["brightness", "color_temp_kelvin", "rgb_color", "effect"],
  lock: ["changed_by"],
  media_player: ["media_title", "media_artist", "source", "volume_level"],
  person: ["source"],
  script: ["last_triggered"],
  switch: ["device_class"],
  todo: ["all_day"],
  update: ["installed_version", "latest_version"],
  vacuum: ["battery_level", "fan_speed"],
  water_heater: ["current_temperature", "temperature"],
};

export function domainOf(entityId: string): string {
  const dot = entityId.indexOf(".");
  return dot === -1 ? entityId : entityId.slice(0, dot);
}

/** `21.4 °C` rather than `21.4` — the unit is what makes a sensor reading answerable. */
export function stateWithUnit(state: string, attributes: Record<string, unknown>): string {
  const unit = attributes["unit_of_measurement"];
  return typeof unit === "string" && unit && state !== "unknown" && state !== "unavailable"
    ? `${state} ${unit}`
    : state;
}

export function listedAttributes(entityId: string, attributes: Record<string, unknown>): string {
  const keys = LISTED_ATTRS[domainOf(entityId)] ?? [];
  const parts: string[] = [];
  for (const key of keys) {
    const value = attributes[key];
    if (value === undefined || value === null || value === "") continue;
    if (key === "brightness" && typeof value === "number") {
      parts.push(`brightness=${Math.round((value / 255) * 100)}%`);
    } else if (key === "volume_level" && typeof value === "number") {
      parts.push(`volume=${Math.round(value * 100)}%`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}=[${value.join(",")}]`);
    } else if (typeof value === "object") {
      continue;
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(" ");
}

export interface ListedEntity {
  entity_id: string;
  name: string;
  state: string;
  attributes: Record<string, unknown>;
}

export function entityLine(entity: ListedEntity): string {
  const attrs = listedAttributes(entity.entity_id, entity.attributes);
  const head = `${entity.entity_id} | ${entity.name} | ${stateWithUnit(entity.state, entity.attributes)}`;
  return attrs ? `${head} | ${attrs}` : head;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

/** `2026-08-25 18:02` in UTC — shorter than ISO and still unambiguous enough to reason about. */
export function shortTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toISOString().slice(0, 16).replace("T", " ");
}

export interface HistorySummary {
  entity_id: string;
  changes: number;
  totals: { state: string; ms: number }[];
  transitions: { at: string; state: string }[];
  current: string | null;
}

/**
 * Turns a raw history series into durations per state plus the transition list.
 * "How long has the light been on today" is then answerable without the caller
 * doing date arithmetic over hundreds of raw samples.
 */
export function summarizeHistory(
  entityId: string,
  entries: HaHistoryEntry[],
  windowEndMs: number,
): HistorySummary {
  const points = entries
    .map((entry) => ({
      state: entry.state,
      at: Date.parse(entry.last_changed ?? entry.last_updated ?? ""),
    }))
    .filter((point) => !Number.isNaN(point.at))
    .sort((a, b) => a.at - b.at);

  const totals = new Map<string, number>();
  const transitions: { at: string; state: string }[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const until = points[i + 1]?.at ?? windowEndMs;
    totals.set(point.state, (totals.get(point.state) ?? 0) + Math.max(0, until - point.at));
    // The first sample is the state on entering the window, not a change within it.
    if (i > 0) transitions.push({ at: new Date(point.at).toISOString(), state: point.state });
  }

  return {
    entity_id: entityId,
    changes: transitions.length,
    totals: [...totals.entries()]
      .map(([state, ms]) => ({ state, ms }))
      .sort((a, b) => b.ms - a.ms),
    transitions,
    current: points.at(-1)?.state ?? null,
  };
}

export function renderHistory(summary: HistorySummary, maxTransitions = 30): string {
  if (summary.totals.length === 0) return `${summary.entity_id} — no recorded history in this window.`;
  const totals = summary.totals
    .map((total) => `${total.state} ${formatDuration(total.ms)}`)
    .join(" · ");
  const shown = summary.transitions.slice(-maxTransitions);
  const lines = [
    `${summary.entity_id} — now ${summary.current}, ${summary.changes} change(s)`,
    `  time in state: ${totals}`,
  ];
  if (summary.transitions.length > shown.length) {
    lines.push(`  (showing the last ${shown.length} of ${summary.transitions.length} changes)`);
  }
  for (const transition of shown) {
    lines.push(`  ${shortTime(transition.at)} → ${transition.state}`);
  }
  return lines.join("\n");
}
