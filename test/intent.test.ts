import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The parser decides whether prose can cause a deploy, so the case that
 * matters most is the near-miss: approval words inside a change request.
 *
 * `chat` adds a second near-miss in the other direction: a question must not
 * spend a build, and feedback must not be answered as small talk. The tests
 * below pin both, and every pre-chat case above them still passes unchanged --
 * which is the point of routing chat on positive evidence rather than making
 * it the fall-through.
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

test("naming an issue asks for a build", () => {
  const cases: [string, number][] = [
    ["work on #16", 16],
    ["work on issue 16", 16],
    ["build #7", 7],
    ["please build #7", 7],
    ["can you implement issue #5", 5],
    ["go ahead and build 12", 12],
    ["hey, tackle #3 next", 3],
    ["implement the feature request 9", 9],
    ["fix #42", 42],
  ];
  for (const [msg, issueNumber] of cases) {
    const intent = parseMentionIntent(`${MENTION} ${msg}`);
    assert.equal(intent.kind, "build", `should be build: ${msg}`);
    assert.equal(intent.kind === "build" ? intent.issueNumber : 0, issueNumber, msg);
  }
});

test("a build word inside feedback does not start a build", () => {
  // The number is there, but the message is about an open PR, not an issue.
  const cases = [
    "looks good but build the config from env, see #11",
    "start over with #11",
    "use a worktree instead of #11's approach",
    "drop the polling in #11",
    "implement it without the timer",
  ];
  for (const msg of cases) {
    assert.notEqual(parseMentionIntent(`${MENTION} ${msg}`).kind, "build", msg);
  }
});

test("rejection reads as reject", () => {
  for (const msg of ["reject", "scrap this", "discard", "start over"]) {
    assert.equal(parseMentionIntent(`${MENTION} ${msg}`).kind, "reject", msg);
  }
});

test("the user's own examples route correctly", () => {
  // Feedback needs a PR in scope to read as feedback; the reply is how you say
  // which one. Without that it is just a request, and the agent takes it.
  assert.equal(
    parseMentionIntent(`${MENTION} hey do this instead`, { replyingToReview: true }).kind,
    "revise",
  );
  assert.equal(parseMentionIntent(`${MENTION} hey do this instead`).kind, "chat");
  assert.equal(parseMentionIntent(`${MENTION} looks good, ship it`).kind, "approve");
});

test("unrecognised prose never falls back to approve", () => {
  // The safety property that has not moved: nothing ambiguous ever deploys.
  for (const ctx of [{}, { replyingToReview: true }]) {
    const intent = parseMentionIntent(
      `${MENTION} the reminder window should be configurable`,
      ctx,
    );
    assert.notEqual(intent.kind, "approve");
  }
});

test("feedback carries the stripped text through", () => {
  const intent = parseMentionIntent(`${MENTION} use a slash command instead of polling`, {
    replyingToReview: true,
  });
  assert.equal(intent.kind, "revise");
  assert.equal(
    intent.kind === "revise" ? intent.feedback : "",
    "use a slash command instead of polling",
  );
});

test("a bare question is answered, not turned into a revision", () => {
  const cases = [
    "what's the weather in japan",
    "who won the world series",
    "why is the sky blue",
    "how do i rebase onto main",
    "explain how oauth works",
    "tell me a joke",
    "hey what is 2+2",
    "can you explain what a monad is",
    "is 17 prime?",
  ];
  for (const msg of cases) {
    assert.equal(parseMentionIntent(`${MENTION} ${msg}`).kind, "chat", msg);
  }
});

test("chat carries the stripped text through", () => {
  const intent = parseMentionIntent(`${MENTION} what's the exchange rate for yen`);
  assert.equal(intent.kind, "chat");
  assert.equal(
    intent.kind === "chat" ? intent.text : "",
    "what's the exchange rate for yen",
  );
});

test("an image is a question even with no caption", () => {
  assert.equal(parseMentionIntent(MENTION, { hasImage: true }).kind, "chat");
  assert.equal(parseMentionIntent(`${MENTION} what breed is this`, { hasImage: true }).kind, "chat");
  // Without one, a bare mention still asks for help rather than guessing.
  assert.equal(parseMentionIntent(MENTION).kind, "help");
});

test("feedback in PR context is still feedback", () => {
  const cases = [
    "do this instead",
    "use a slash command instead of polling",
    "the reminder window should be configurable",
    "implement it without the timer",
    "drop the polling?",
  ];
  for (const msg of cases) {
    assert.equal(
      parseMentionIntent(`${MENTION} ${msg}`, { replyingToReview: true }).kind,
      "revise",
      msg,
    );
  }
});

test("ordinary requests are not mistaken for pull request feedback", () => {
  // The regression this reversal fixes. Every one of these read as `revise`
  // before, because the fall-through was revise and REVISION_MARKERS is a list
  // of ordinary verbs -- "add", "use", "make it" -- that any task contains.
  const cases = [
    "fetch me the latest hakos baelz threads off /vt/",
    "download that video",
    "make me a collage of these",
    "add subtitles to this clip",
    "find the top posts today",
    "use ffmpeg to trim the first 10 seconds",
    "remove the background from this image",
    "change this to a webp",
  ];
  for (const msg of cases) {
    assert.equal(parseMentionIntent(`${MENTION} ${msg}`).kind, "chat", msg);
  }
});

test("PR context keeps a question on the review path", () => {
  // Naming a PR, or replying to one of the bot's review messages, says the
  // message is about the code rather than a request of its own.
  assert.equal(parseMentionIntent(`${MENTION} why did you add a timer to #11`).kind, "revise");
  assert.equal(
    parseMentionIntent(`${MENTION} why did you add a timer`, { replyingToReview: true }).kind,
    "revise",
  );
});

test("replying to a chat answer does not become a revision", () => {
  // A reply to the bot is only review context when the bot was reviewing. This
  // is what makes a conversational follow-up possible at all.
  assert.equal(parseMentionIntent(`${MENTION} now crop it`, { replyingToReview: false }).kind, "chat");
  assert.equal(parseMentionIntent(`${MENTION} do the other one instead`).kind, "chat");
});

test("chat never displaces a build, an approval or a rejection", () => {
  assert.equal(parseMentionIntent(`${MENTION} what's the weather`, { hasImage: true }).kind, "chat");
  // ...but an image doesn't turn a deploy into a chat.
  assert.equal(parseMentionIntent(`${MENTION} build #7`, { hasImage: true }).kind, "build");
  assert.equal(parseMentionIntent(`${MENTION} lgtm`, { hasImage: true }).kind, "approve");
  assert.equal(parseMentionIntent(`${MENTION} reject`, { hasImage: true }).kind, "reject");
});
