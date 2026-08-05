import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The two predicates the token-burn work turned into real logic. Both were
 * loose before, and in both cases the loose branch was the expensive one.
 */

const { looksLikeMissingSession, revisionRoundsFromPrBody } = await import("../src/naming.ts");

test("a genuinely missing session is detected, so the retry still happens", () => {
  for (const err of [
    "Session cse_01ABC not found",
    "No such session: abc-123",
    "session abc does not exist",
    "Invalid session id",
  ]) {
    assert.equal(looksLikeMissingSession(err), true, err);
  }
});

test("unrelated failures do NOT buy a second full agent run", () => {
  // Each of these mentions a session, or an absence, but not both -- the old
  // regex matched every one and silently doubled the bill for a revision.
  for (const err of [
    "Session ended with an API error",
    "Error in session: rate limit exceeded",
    "the session was interrupted",
    "file not found: src/foo.ts",
    "command not found: npm",
    "ENOENT: no such file or directory",
  ]) {
    assert.equal(looksLikeMissingSession(err), false, err);
  }
});

test("no error means no retry", () => {
  assert.equal(looksLikeMissingSession(undefined), false);
  assert.equal(looksLikeMissingSession(""), false);
});

test("revision rounds are counted from the PR body", () => {
  assert.equal(revisionRoundsFromPrBody(null), 0);
  assert.equal(revisionRoundsFromPrBody("A summary with no rounds yet"), 0);

  const afterTwo = [
    "Original summary.",
    "",
    "_Revision 1, $0.412: drop the polling watcher_",
    "",
    "_Revision 2, $0.688: rename the module_",
  ].join("\n");
  assert.equal(revisionRoundsFromPrBody(afterTwo), 2);
});

test("prose mentioning a revision is not miscounted as a round", () => {
  // Only the stamped marker at line start counts; the agent's own summary
  // routinely contains the word.
  const body = "This is a revision of the parser. Revision handling improved.";
  assert.equal(revisionRoundsFromPrBody(body), 0);
});
