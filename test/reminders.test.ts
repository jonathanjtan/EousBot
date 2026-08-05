import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the usage-reset bookkeeping behind /remindme.
 *
 * Imported directly, like the /usage tests, so the suite doesn't pull in
 * src/config.ts. Arming the timer lives in src/usagewatch.ts and needs a
 * gateway connection, so it isn't exercised here.
 */

const {
  MISSED_RESET_GRACE_MS,
  REMIND_THRESHOLD,
  dueResets,
  formatReminder,
  nextResetAt,
  rememberWindows,
} = await import("../src/reminders.ts");

const now = Date.parse("2026-08-05T06:00:00.000Z");
const past = "2026-08-05T05:00:00.000Z";
const future = "2026-08-05T11:00:00.000Z";
const later = "2026-08-10T06:00:00.000Z";

const SESSION = "Current session (5h)";
const WEEK = "This week (all models)";

test("rememberWindows keeps the reset time and utilization of each window", () => {
  const memory = rememberWindows([
    { label: SESSION, utilization: 80, resetsAt: future },
    { label: WEEK, utilization: null, resetsAt: later },
  ]);
  assert.deepEqual(memory[SESSION], { resetsAt: future, utilization: 80 });
  assert.deepEqual(memory[WEEK], { resetsAt: later, utilization: null });
});

test("rememberWindows drops windows with no usable reset timestamp", () => {
  const memory = rememberWindows([
    { label: SESSION, utilization: 95, resetsAt: null },
    { label: WEEK, utilization: 95, resetsAt: "nope" },
  ]);
  assert.deepEqual(memory, {});
});

test("dueResets fires for a busy window whose moment has passed", () => {
  const memory = { [SESSION]: { resetsAt: past, utilization: 92 } };
  const { events, remaining } = dueResets(memory, now, MISSED_RESET_GRACE_MS);
  assert.deepEqual(events, [{ label: SESSION, previousUtilization: 92 }]);
  // Dropped once handled, so re-arming can't announce the same reset twice.
  assert.deepEqual(remaining, {});
});

test("dueResets leaves windows that haven't reset yet alone", () => {
  const memory = { [SESSION]: { resetsAt: future, utilization: 95 } };
  const { events, remaining } = dueResets(memory, now, MISSED_RESET_GRACE_MS);
  assert.deepEqual(events, []);
  assert.deepEqual(remaining, memory);
});

test("dueResets stays quiet for a window that was barely used", () => {
  const memory = { [SESSION]: { resetsAt: past, utilization: REMIND_THRESHOLD - 1 } };
  const { events, remaining } = dueResets(memory, now, MISSED_RESET_GRACE_MS);
  assert.deepEqual(events, []);
  // Still forgotten -- an entry that never leaves would re-arm the timer forever.
  assert.deepEqual(remaining, {});
});

test("dueResets drops a reset that went stale during an outage", () => {
  const long = Date.parse("2026-08-04T06:00:00.000Z");
  const memory = { [SESSION]: { resetsAt: new Date(long).toISOString(), utilization: 99 } };
  const { events, remaining } = dueResets(memory, now, MISSED_RESET_GRACE_MS);
  assert.deepEqual(events, []);
  assert.deepEqual(remaining, {});
});

test("dueResets reports every window that came due at once", () => {
  const memory = {
    [SESSION]: { resetsAt: past, utilization: 92 },
    [WEEK]: { resetsAt: past, utilization: 88 },
  };
  const { events } = dueResets(memory, now, MISSED_RESET_GRACE_MS);
  assert.deepEqual(events.map((e) => e.label).sort(), [SESSION, WEEK].sort());
});

test("nextResetAt picks the earliest reset worth a ping", () => {
  const at = nextResetAt({
    [SESSION]: { resetsAt: future, utilization: 95 },
    [WEEK]: { resetsAt: later, utilization: 91 },
  });
  assert.equal(at, Date.parse(future));
});

test("nextResetAt ignores windows below the threshold", () => {
  const at = nextResetAt({
    [SESSION]: { resetsAt: future, utilization: 3 },
    [WEEK]: { resetsAt: later, utilization: 91 },
  });
  assert.equal(at, Date.parse(later));
});

test("nextResetAt returns null when nothing is full enough to announce", () => {
  assert.equal(nextResetAt({}), null);
  assert.equal(nextResetAt({ [SESSION]: { resetsAt: future, utilization: null } }), null);
});

test("formatReminder mentions every subscriber and names each window", () => {
  const text = formatReminder(
    [
      { label: SESSION, previousUtilization: 92.4 },
      { label: "This week (Opus)", previousUtilization: null },
    ],
    ["111", "222"],
  );
  assert.ok(text.includes("<@111> <@222>"), text);
  assert.ok(text.includes(SESSION), text);
  assert.ok(text.includes("92%"), text);
  assert.ok(text.includes("an unknown level"), text);
});
