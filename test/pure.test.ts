import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the pure logic that the build gate depends on.
 *
 * These modules are imported directly rather than through the barrel so the
 * suite doesn't pull in src/config.ts, which exits the process on missing
 * environment variables -- the gate has to run in CI without secrets.
 */

const { branchNameFor } = await import("../src/naming.ts");
const { encodeCustomId, decodeCustomId } = await import("../src/approval.ts");
const {
  CHOICE_LIMITS,
  EFFORT_CHOICES,
  MODEL_CHOICES,
  describeAgentOptions,
  parseEffort,
  parseModel,
} = await import("../src/agentopts.ts");

test("branchNameFor slugifies and anchors on the issue number", () => {
  assert.equal(branchNameFor(12, "Add a /roll command"), "eous/12-add-a-roll-command");
  assert.equal(branchNameFor(3, "Fix   THE   Thing!!!"), "eous/3-fix-the-thing");
});

test("branchNameFor produces a valid ref from hostile titles", () => {
  // Discord input reaches this function directly; git refs reject these.
  for (const title of ["../../etc/passwd", "a b; rm -rf /", "***", "  ", "→→→"]) {
    const branch = branchNameFor(1, title);
    assert.match(branch, /^eous\/1-[a-z0-9-]*$/, `bad ref for ${JSON.stringify(title)}`);
    assert.ok(!branch.includes(".."), "ref must not contain ..");
    assert.ok(!branch.endsWith("-"), "ref must not end with a separator");
  }
});

test("branchNameFor falls back when a title slugifies to nothing", () => {
  assert.equal(branchNameFor(7, "!!!"), "eous/7-request");
});

test("approval custom IDs round-trip", () => {
  for (const issueNumber of [42, null]) {
    for (const action of ["approve", "reject"] as const) {
      const encoded = encodeCustomId({ action, prNumber: 9, issueNumber });
      assert.ok(encoded.length <= 100, "Discord caps custom IDs at 100 chars");
      assert.deepEqual(decodeCustomId(encoded), { action, prNumber: 9, issueNumber });
    }
  }
});

test("parseModel and parseEffort accept only the offered choices", () => {
  assert.equal(parseModel("claude-opus-5"), "claude-opus-5");
  assert.equal(parseEffort("xhigh"), "xhigh");

  // Discord enforces the same lists, so a rejection here means a stale command
  // schema or a hand-crafted interaction -- fall back to the configured default.
  for (const bad of [null, "", "opus 5", "gpt-4", "claude-opus-5 "]) {
    assert.equal(parseModel(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, "", "ultra", "HIGH", "10"]) {
    assert.equal(parseEffort(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
});

test("choice lists stay inside Discord's limits", () => {
  for (const choices of [MODEL_CHOICES, EFFORT_CHOICES]) {
    assert.ok(choices.length > 0 && choices.length <= CHOICE_LIMITS.count);
    assert.equal(
      new Set(choices.map((c) => c.value)).size,
      choices.length,
      "choice values must be unique",
    );
    for (const { name, value } of choices) {
      assert.ok(name.length > 0 && name.length <= CHOICE_LIMITS.nameLength, name);
      assert.ok(value.length > 0 && value.length <= CHOICE_LIMITS.valueLength, value);
    }
  }
});

test("describeAgentOptions omits effort when none was resolved", () => {
  assert.equal(describeAgentOptions("claude-opus-5", "max"), "claude-opus-5, max effort");
  assert.equal(describeAgentOptions("claude-opus-5", null), "claude-opus-5");
});

test("decodeCustomId rejects anything it did not mint", () => {
  for (const bad of [
    "",
    "other:approve:1:2",
    "eous:destroy:1:2",
    "eous:approve:notanumber:2",
    "totally unrelated button",
  ]) {
    assert.equal(decodeCustomId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});
