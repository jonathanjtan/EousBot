import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the usage-reset detection behind /remindme.
 *
 * Imported directly, like the /usage tests, so the suite doesn't pull in
 * src/config.ts. The polling loop itself lives in src/usagewatch.ts and needs
 * a real Claude session, so it isn't exercised here.
 */

const { REMIND_THRESHOLD, diffResets, formatReminder } = await import("../src/reminders.ts");

const now = Date.parse("2026-08-05T06:00:00.000Z");
const past = "2026-08-05T05:00:00.000Z";
const future = "2026-08-05T11:00:00.000Z";

const window = (utilization: number | null, resetsAt: string | null) => ({
  label: "Current session (5h)",
  utilization,
  resetsAt,
});

test("diffResets reports nothing on the first reading, but remembers it", () => {
  const { events, next } = diffResets({}, [window(80, future)], now);
  assert.deepEqual(events, []);
  assert.deepEqual(next["Current session (5h)"], { resetsAt: future, utilization: 80 });
});

test("diffResets fires when a busy window rolls over to a new reset time", () => {
  const previous = { "Current session (5h)": { resetsAt: past, utilization: 92 } };
  const { events } = diffResets(previous, [window(3, future)], now);
  assert.deepEqual(events, [{ label: "Current session (5h)", previousUtilization: 92 }]);
});

test("diffResets stays quiet for a window that was barely used", () => {
  const previous = {
    "Current session (5h)": { resetsAt: past, utilization: REMIND_THRESHOLD - 1 },
  };
  assert.deepEqual(diffResets(previous, [window(0, future)], now).events, []);
});

test("diffResets waits for the remembered reset to actually pass", () => {
  // Same window, new timestamp, but the old one is still in the future -- the
  // server moved the boundary rather than rolling the window over.
  const previous = { "Current session (5h)": { resetsAt: future, utilization: 95 } };
  const later = "2026-08-05T12:00:00.000Z";
  assert.deepEqual(diffResets(previous, [window(95, later)], now).events, []);
});

test("diffResets ignores an unchanged reset time", () => {
  const previous = { "Current session (5h)": { resetsAt: future, utilization: 95 } };
  assert.deepEqual(diffResets(previous, [window(96, future)], now).events, []);
});

test("diffResets skips windows with no usable reset timestamp", () => {
  const { events, next } = diffResets({}, [window(95, null), window(95, "nope")], now);
  assert.deepEqual(events, []);
  assert.deepEqual(next, {});
});

test("diffResets drops windows the API stopped reporting", () => {
  const previous = { "This week (Opus)": { resetsAt: past, utilization: 99 } };
  const { next } = diffResets(previous, [window(1, future)], now);
  assert.deepEqual(Object.keys(next), ["Current session (5h)"]);
});

test("formatReminder mentions every subscriber and names each window", () => {
  const text = formatReminder(
    [
      { label: "Current session (5h)", previousUtilization: 92.4 },
      { label: "This week (Opus)", previousUtilization: null },
    ],
    ["111", "222"],
  );
  assert.ok(text.includes("<@111> <@222>"), text);
  assert.ok(text.includes("Current session (5h)"), text);
  assert.ok(text.includes("92%"), text);
  assert.ok(text.includes("an unknown level"), text);
});
