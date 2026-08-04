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
