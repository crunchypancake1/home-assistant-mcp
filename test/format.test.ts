import { describe, it, expect } from "vitest";
import {
  domainOf,
  entityLine,
  formatDuration,
  listedAttributes,
  renderHistory,
  shortTime,
  stateWithUnit,
  summarizeHistory,
} from "../src/ha/format";

describe("domainOf", () => {
  it("splits on the first dot", () => {
    expect(domainOf("light.kitchen")).toBe("light");
    expect(domainOf("weird")).toBe("weird");
  });
});

describe("stateWithUnit", () => {
  it("appends the unit", () => {
    expect(stateWithUnit("21.4", { unit_of_measurement: "°C" })).toBe("21.4 °C");
  });

  it("leaves unavailable states alone", () => {
    expect(stateWithUnit("unavailable", { unit_of_measurement: "°C" })).toBe("unavailable");
    expect(stateWithUnit("on", {})).toBe("on");
  });
});

describe("listedAttributes", () => {
  it("scales brightness and volume to percentages", () => {
    expect(listedAttributes("light.a", { brightness: 255 })).toBe("brightness=100%");
    expect(listedAttributes("media_player.a", { volume_level: 0.25 })).toBe("volume=25%");
  });

  it("keeps only the attributes listed for the domain", () => {
    const attrs = { last_triggered: "2026-01-01T00:00:00+00:00", mode: "single", id: "1" };
    expect(listedAttributes("automation.a", attrs)).toBe("last_triggered=2026-01-01T00:00:00+00:00");
  });

  it("renders arrays and skips nested objects and empty values", () => {
    expect(listedAttributes("light.a", { rgb_color: [255, 0, 0], effect: "" })).toBe("rgb_color=[255,0,0]");
    expect(listedAttributes("media_player.a", { source: { nested: true } })).toBe("");
  });
});

describe("entityLine", () => {
  it("renders id, name, state and the interesting attributes", () => {
    expect(
      entityLine({
        entity_id: "light.kitchen",
        name: "Kitchen Ceiling",
        state: "on",
        attributes: { brightness: 128, friendly_name: "Kitchen Ceiling" },
      }),
    ).toBe("light.kitchen | Kitchen Ceiling | on | brightness=50%");
  });

  it("omits the attribute column when there is nothing to show", () => {
    expect(entityLine({ entity_id: "lock.front", name: "Front Door", state: "locked", attributes: {} })).toBe(
      "lock.front | Front Door | locked",
    );
  });
});

describe("formatDuration", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(90_000)).toBe("1m");
    expect(formatDuration(3 * 3600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(formatDuration(50 * 3600_000)).toBe("2d 2h");
  });
});

describe("shortTime", () => {
  it("trims to minutes and passes unparseable input through", () => {
    expect(shortTime("2026-08-25T18:02:33+00:00")).toBe("2026-08-25 18:02");
    expect(shortTime("not a date")).toBe("not a date");
  });
});

describe("summarizeHistory", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 7, 25, h)).toISOString();
  const windowEnd = Date.UTC(2026, 7, 25, 12);

  it("totals time per state and counts only in-window changes", () => {
    const summary = summarizeHistory("light.a", [
      { state: "off", last_changed: t(0) },
      { state: "on", last_changed: t(8) },
      { state: "off", last_changed: t(9) },
    ], windowEnd);

    // The first sample is the state on entering the window, not a change within it.
    expect(summary.changes).toBe(2);
    expect(summary.current).toBe("off");
    expect(summary.totals).toEqual([
      { state: "off", ms: 11 * 3600_000 },
      { state: "on", ms: 1 * 3600_000 },
    ]);
  });

  it("falls back to last_updated and drops unparseable samples", () => {
    const summary = summarizeHistory("light.a", [
      { state: "on", last_updated: t(6) },
      { state: "off", last_changed: "garbage" },
    ], windowEnd);
    expect(summary.totals).toEqual([{ state: "on", ms: 6 * 3600_000 }]);
  });

  it("handles an entity with no recorded history", () => {
    expect(summarizeHistory("light.a", [], windowEnd)).toMatchObject({ changes: 0, current: null, totals: [] });
  });
});

describe("renderHistory", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 7, 25, h)).toISOString();
  const windowEnd = Date.UTC(2026, 7, 25, 12);

  it("leads with the totals and lists the changes", () => {
    const out = renderHistory(
      summarizeHistory("light.a", [
        { state: "off", last_changed: t(0) },
        { state: "on", last_changed: t(8) },
      ], windowEnd),
    );
    expect(out).toContain("light.a — now on, 1 change(s)");
    expect(out).toContain("time in state: off 8h 0m · on 4h 0m");
    expect(out).toContain("2026-08-25 08:00 → on");
  });

  it("keeps the most recent changes and says what it dropped", () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      state: i % 2 === 0 ? "on" : "off",
      last_changed: new Date(Date.UTC(2026, 7, 25, 0, i)).toISOString(),
    }));
    const out = renderHistory(summarizeHistory("light.a", entries, windowEnd), 5);
    expect(out).toContain("showing the last 5 of 59 changes");
    expect(out).toContain("2026-08-25 00:59");
  });

  it("says so when the window is empty", () => {
    expect(renderHistory(summarizeHistory("light.a", [], windowEnd))).toContain("no recorded history");
  });
});
