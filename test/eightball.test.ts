import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the Magic 8-Ball's answers and reply formatting.
 *
 * Imported directly rather than through the command module so the suite doesn't
 * pull in src/config.ts, which exits the process on missing environment
 * variables. The pick is random, so assertions are on membership and on a
 * pinned generator where an exact answer matters.
 */

const { ANSWERS, MAX_QUESTION_LENGTH, formatAnswer, pickAnswer } = await import(
  "../src/eightball.ts"
);

test("carries the twenty answers a real 8-ball is printed with", () => {
  assert.equal(ANSWERS.length, 20);
  assert.equal(new Set(ANSWERS).size, 20, "answers must not repeat");
});

test("pickAnswer only ever returns an answer from the list", () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(ANSWERS.includes(pickAnswer()), "picked something off the ball");
  }
});

test("pickAnswer covers both ends of the list", () => {
  assert.equal(pickAnswer(() => 0), ANSWERS[0]);
  assert.equal(pickAnswer(() => 0.999999999), ANSWERS[ANSWERS.length - 1]);
});

test("formatAnswer echoes the question alongside the answer", () => {
  assert.equal(
    formatAnswer("will it rain tomorrow?", "Signs point to yes."),
    '🎱 "will it rain tomorrow?" → **Signs point to yes.**',
  );
});

test("formatAnswer collapses whitespace in the echo", () => {
  assert.equal(
    formatAnswer("  will   it\nrain?  ", "Most likely."),
    '🎱 "will it rain?" → **Most likely.**',
  );
});

test("formatAnswer strips formatting and mention characters from the echo", () => {
  // A question must not be able to ping the guild or forge markdown in the reply.
  assert.equal(
    formatAnswer("`**<@92457122230439936>**` ||spoiler||", "Very doubtful."),
    '🎱 "92457122230439936 spoiler" → **Very doubtful.**',
  );
});

test("formatAnswer truncates a long question instead of flooding the channel", () => {
  const reply = formatAnswer("a".repeat(MAX_QUESTION_LENGTH * 3), "Ask again later.");
  assert.ok(reply.includes("…"), "should mark the elision");
  assert.ok(reply.length < MAX_QUESTION_LENGTH + 100, `reply too long: ${reply.length}`);
});

test("formatAnswer still answers a question that sanitises to nothing", () => {
  assert.equal(formatAnswer("   ", "Cannot predict now."), "🎱 Cannot predict now.");
  assert.equal(formatAnswer("***", "Cannot predict now."), "🎱 Cannot predict now.");
});
