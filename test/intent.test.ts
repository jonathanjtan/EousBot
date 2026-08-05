import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The parser decides whether prose can cause a deploy, so the case that
 * matters most is the near-miss: approval words inside a change request.
 */

const { parseMentionIntent, stripMentions } = await import("../src/intent.ts");

const MENTION = "<@765457373157392404>";

test("mentions are stripped wherever they appear", () => {
  assert.equal(stripMentions(`${MENTION} do the thing`), "do the thing");
  assert.equal(stripMentions(`hey ${MENTION} do the thing`), "hey do the thing");
  assert.equal(stripMentions(`<@!123> spaced   out  `), "spaced out");
});

test("a bare mention asks for help rather than guessing", () => {
  for (const msg of [MENTION, `${MENTION} help`, `${MENTION} ?`]) {
    assert.equal(parseMentionIntent(msg).kind, "help", msg);
  }
});

test("plain approval reads as approve", () => {
  for (const msg of ["looks good, ship it", "lgtm", "approve", "send it", "go ahead"]) {
    assert.equal(parseMentionIntent(`${MENTION} ${msg}`).kind, "approve", msg);
  }
});

test("approval words inside a change request do NOT approve", () => {
  // The dangerous case: each of these contains an approval phrase.
  const cases = [
    "looks good but drop the polling watcher",
    "lgtm, though can you rename the module",
    "looks good — use a slash command instead",
    "ship it after you remove the timer",
    "approve this once you add tests",
  ];
  for (const msg of cases) {
    const intent = parseMentionIntent(`${MENTION} ${msg}`);
    assert.equal(intent.kind, "revise", `should be revise: ${msg}`);
  }
});

test("rejection reads as reject", () => {
  for (const msg of ["reject", "scrap this", "discard", "start over"]) {
    assert.equal(parseMentionIntent(`${MENTION} ${msg}`).kind, "reject", msg);
  }
});

test("the user's own examples route correctly", () => {
  assert.equal(parseMentionIntent(`${MENTION} hey do this instead`).kind, "revise");
  assert.equal(parseMentionIntent(`${MENTION} looks good, ship it`).kind, "approve");
});

test("unrecognised prose falls back to revise, never to approve", () => {
  const intent = parseMentionIntent(`${MENTION} the reminder window should be configurable`);
  assert.equal(intent.kind, "revise");
  assert.equal(
    intent.kind === "revise" ? intent.feedback : "",
    "the reminder window should be configurable",
  );
});

test("feedback carries the stripped text through", () => {
  const intent = parseMentionIntent(`${MENTION} use a slash command instead of polling`);
  assert.equal(intent.kind, "revise");
  assert.equal(
    intent.kind === "revise" ? intent.feedback : "",
    "use a slash command instead of polling",
  );
});
