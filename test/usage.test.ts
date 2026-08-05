import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the /usage rendering.
 *
 * Imported directly rather than through the command module so the suite
 * doesn't pull in src/config.ts, which exits the process on missing
 * environment variables. Fetching the live figures lives in src/agent.ts and
 * isn't exercised here -- it needs a real Claude session.
 */

const { collectWindows, describePlan, formatBar, formatWindow, usageColour } = await import(
  "../src/usage.ts"
);

const payload = {
  five_hour: { utilization: 31, resets_at: "2026-08-05T05:00:00.000Z" },
  seven_day: { utilization: 35, resets_at: "2026-08-10T06:00:00.000Z" },
  seven_day_opus: null,
  seven_day_sonnet: null,
};

test("collectWindows keeps the reported windows and drops the null ones", () => {
  const windows = collectWindows(payload);
  assert.deepEqual(
    windows.map((w) => w.label),
    ["Current session (5h)", "This week (all models)"],
  );
  assert.equal(windows[0]?.utilization, 31);
  assert.equal(windows[1]?.resetsAt, "2026-08-10T06:00:00.000Z");
});

test("collectWindows appends the per-model weekly windows", () => {
  const windows = collectWindows({
    ...payload,
    model_scoped: [{ display_name: "Fable", utilization: 12, resets_at: null }],
  });
  const scoped = windows.at(-1);
  assert.equal(scoped?.label, "This week (Fable)");
  assert.equal(scoped?.utilization, 12);
  assert.equal(scoped?.resetsAt, null);
});

test("collectWindows tolerates an account with no limits at all", () => {
  assert.deepEqual(collectWindows(null), []);
  assert.deepEqual(collectWindows({}), []);
});

test("formatBar fills in proportion to the utilization", () => {
  assert.match(formatBar(0), /^`░{20}` 0%$/);
  assert.match(formatBar(50), /^`█{10}░{10}` 50%$/);
  assert.match(formatBar(100), /^`█{20}` 100%$/);
});

test("formatBar clamps values outside 0-100 rather than mangling the bar", () => {
  assert.match(formatBar(140), /^`█{20}` 100%$/);
  assert.match(formatBar(-5), /^`░{20}` 0%$/);
});

test("formatBar renders an unknown utilization as empty with no percentage", () => {
  assert.equal(formatBar(null), "`" + "░".repeat(20) + "` —");
});

test("formatWindow renders the reset as a Discord relative timestamp", () => {
  const line = formatWindow({
    label: "Current session (5h)",
    utilization: 25,
    resetsAt: "2026-08-05T05:00:00.000Z",
  });
  assert.ok(line.includes("25%"), line);
  assert.ok(line.includes(`<t:${Date.parse("2026-08-05T05:00:00.000Z") / 1000}:R>`), line);
});

test("formatWindow says so when the reset time is missing or unparseable", () => {
  const missing = formatWindow({ label: "x", utilization: 10, resetsAt: null });
  const broken = formatWindow({ label: "x", utilization: 10, resetsAt: "not a date" });
  assert.ok(missing.includes("reset time unknown"), missing);
  assert.ok(broken.includes("reset time unknown"), broken);
});

test("usageColour escalates with the fullest window", () => {
  const at = (utilization: number) => [{ label: "x", utilization, resetsAt: null }];
  assert.equal(usageColour(at(10)), 0x2f9e44);
  assert.equal(usageColour(at(60)), 0xe0a458);
  assert.equal(usageColour(at(95)), 0xd7263d);
  // The peak decides, not the last window listed.
  assert.equal(usageColour([...at(95), ...at(1)]), 0xd7263d);
  assert.equal(usageColour([]), 0x2f9e44);
});

test("describePlan names the subscription when limits apply", () => {
  const line = describePlan({
    subscriptionType: "pro",
    rateLimitsAvailable: true,
    windows: [],
  });
  assert.ok(line.startsWith("Claude Pro"), line);
});

test("describePlan explains an account with no plan limits", () => {
  const line = describePlan({
    subscriptionType: null,
    rateLimitsAvailable: false,
    windows: [],
  });
  assert.ok(line.includes("per token"), line);
});
