import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The house style, checked against itself.
 *
 * A style prompt that breaks its own rules is asking the model to weigh the
 * instruction against the example directly beneath it, and the example usually
 * wins. So the rules are dogfooded: whatever this file bans, it must not do.
 */

const { UNSLOP_RULES } = await import("../src/unslop.ts");

/** The banned marks. Straight quotes and ASCII dashes are the whole point. */
const BANNED_CHARACTERS: [string, string][] = [
  ["—", "em dash"],
  ["–", "en dash"],
  ["“", "curly open quote"],
  ["”", "curly close quote"],
  ["‘", "curly open apostrophe"],
  ["’", "curly apostrophe"],
];

test("the rules obey their own punctuation bans", () => {
  for (const [char, name] of BANNED_CHARACTERS) {
    assert.ok(!UNSLOP_RULES.includes(char), `rules contain a ${name}`);
  }
});

test("the rules do not use the vocabulary they ban", () => {
  // Only the words that would be embarrassing in situ. "Bold" and "dash" have
  // to survive, since the rules name them to ban them.
  const banned = ["seamless", "robust", "utilize", "leverage", "delve", "testament"];
  for (const word of banned) {
    const uses = UNSLOP_RULES.split(/\b/).filter((t) => t.toLowerCase() === word).length;
    // One mention is the ban itself; a second would be the rules using it.
    assert.ok(uses <= 1, `"${word}" appears ${uses} times, so one of them is not the ban`);
  }
});

test("the worked example is present and shows both halves", () => {
  // The example does more work than the rules above it, so losing it in an
  // edit should fail rather than quietly weaken the prompt.
  assert.match(UNSLOP_RULES, /Bad:/);
  assert.match(UNSLOP_RULES, /Good:/);
  assert.ok(
    UNSLOP_RULES.indexOf("Bad:") < UNSLOP_RULES.indexOf("Good:"),
    "the bad version should come first, so the good one lands last",
  );
});

test("the rules stay small enough to pay for on every turn", () => {
  // This rides in the system prompt of every chat turn. The full unslop skill
  // is ~31 rules of essay guidance; this is the subset that fits a Discord
  // reply, and it should stay that way.
  assert.ok(UNSLOP_RULES.length < 2500, `rules are ${UNSLOP_RULES.length} chars, trim them`);
});
