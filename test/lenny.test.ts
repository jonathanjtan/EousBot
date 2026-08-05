import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the Lenny faces and their Discord escaping.
 *
 * Imported directly rather than through the command module so the suite doesn't
 * pull in src/config.ts, which exits the process on missing environment
 * variables. The pick is random, so assertions are on membership and on a
 * pinned generator where an exact face matters.
 */

const { FACES, LENNY, formatFace, pickFace } = await import("../src/lenny.ts");

test("the canonical Lenny leads the list and appears once", () => {
  assert.equal(LENNY, "( ͡° ͜ʖ ͡°)");
  assert.equal(FACES[0], LENNY);
  assert.equal(new Set(FACES).size, FACES.length, "faces must not repeat");
});

test("pickFace only ever returns a face from the list", () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(FACES.includes(pickFace()), "picked something off the list");
  }
});

test("pickFace covers both ends of the list", () => {
  assert.equal(pickFace(() => 0), FACES[0]);
  assert.equal(pickFace(() => 0.999999999), FACES[FACES.length - 1]);
});

test("formatFace leaves the canonical Lenny untouched", () => {
  assert.equal(formatFace(LENNY), LENNY);
});

test("formatFace escapes the characters Discord reads as markdown", () => {
  assert.equal(formatFace("¯\\_( ͡° ͜ʖ ͡°)_/¯"), "¯\\\\\\_( ͡° ͜ʖ ͡°)\\_/¯");
  assert.equal(formatFace("`*~|"), "\\`\\*\\~\\|");
});

test("every face survives formatting as something Discord will show verbatim", () => {
  for (const face of FACES) {
    const formatted = formatFace(face);
    // Undoing the escapes has to give the face back exactly.
    assert.equal(formatted.replace(/\\(.)/g, "$1"), face);
    // And nothing unescaped may be left to eat the arms off a face.
    assert.ok(
      !/(^|[^\\])[`*_~|]/.test(formatted),
      `unescaped markdown left in ${formatted}`,
    );
  }
});
