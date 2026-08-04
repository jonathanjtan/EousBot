import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for dice notation parsing and rolling.
 *
 * Imported directly rather than through the command module so the suite doesn't
 * pull in src/config.ts, which exits the process on missing environment
 * variables. Rolls are random, so assertions are on ranges and parse results;
 * where an exact total matters the tests pin the generator.
 */

const { MAX_DICE, MAX_SIDES, formatRoll, parseDiceNotation, rollDice } = await import(
  "../src/dice.ts"
);

function specFor(notation: string) {
  const parsed = parseDiceNotation(notation);
  assert.ok(parsed.ok, `expected ${notation} to parse: ${parsed.ok ? "" : parsed.error}`);
  return parsed.spec;
}

test("parses a plain d20 as one die with no modifier", () => {
  assert.deepEqual(specFor("d20"), { count: 1, sides: 20, modifier: 0 });

  const result = rollDice(specFor("d20"));
  assert.equal(result.rolls.length, 1);
  assert.ok(result.total >= 1 && result.total <= 20, `total out of range: ${result.total}`);
});

test("parses a positive modifier and adds it to the total", () => {
  assert.deepEqual(specFor("2d6+3"), { count: 2, sides: 6, modifier: 3 });

  const result = rollDice(specFor("2d6+3"));
  assert.equal(result.rolls.length, 2);
  for (const roll of result.rolls) {
    assert.ok(roll >= 1 && roll <= 6, `die out of range: ${roll}`);
  }
  assert.equal(result.total, result.rolls[0]! + result.rolls[1]! + 3);
  assert.ok(result.total >= 5 && result.total <= 15, `total out of range: ${result.total}`);
});

test("parses a negative modifier and subtracts it from the total", () => {
  assert.deepEqual(specFor("4d6-1"), { count: 4, sides: 6, modifier: -1 });

  const result = rollDice(specFor("4d6-1"));
  assert.equal(result.rolls.length, 4);
  assert.equal(
    result.total,
    result.rolls.reduce((sum, roll) => sum + roll, 0) - 1,
  );
  assert.ok(result.total >= 3 && result.total <= 23, `total out of range: ${result.total}`);
});

test("rejects malformed notation with a friendly error naming an example", () => {
  for (const bad of ["", "hello", "d", "2d", "20", "2d6+", "2d6+x", "d6d6", "-2d6", "2 d 6", "2d6.5"]) {
    const parsed = parseDiceNotation(bad);
    assert.ok(!parsed.ok, `should reject ${JSON.stringify(bad)}`);
    assert.ok(parsed.error.length > 0, "error must not be empty");
    assert.match(parsed.error, /2d6\+3/, "error should show a valid example");
  }
});

test("rejects rolls with no dice or no sides", () => {
  for (const bad of ["0d6", "2d0"]) {
    assert.ok(!parseDiceNotation(bad).ok, `should reject ${JSON.stringify(bad)}`);
  }
});

test("allows the limit boundaries and refuses just past them", () => {
  assert.deepEqual(specFor(`${MAX_DICE}d${MAX_SIDES}`), {
    count: MAX_DICE,
    sides: MAX_SIDES,
    modifier: 0,
  });

  const tooManyDice = parseDiceNotation(`${MAX_DICE + 1}d6`);
  assert.ok(!tooManyDice.ok);
  assert.match(tooManyDice.error, new RegExp(String(MAX_DICE)), "should state the dice limit");

  const tooManySides = parseDiceNotation(`2d${MAX_SIDES + 1}`);
  assert.ok(!tooManySides.ok);
  assert.match(tooManySides.error, new RegExp(String(MAX_SIDES)), "should state the sides limit");
});

test("the day-one absurd input gets the limit, not a wall of numbers", () => {
  const parsed = parseDiceNotation("999999d999999");
  assert.ok(!parsed.ok);
  assert.ok(parsed.error.length < 200, "refusal should be short");
});

test("formatRoll shows the dice, the modifier, and the total", () => {
  // Pinned generator: 0.5 of a six-sided die is always a 4.
  assert.equal(formatRoll(rollDice(specFor("2d6+3"), () => 0.5)), "2d6+3 → [4, 4] +3 = **11**");
  assert.equal(formatRoll(rollDice(specFor("2d6-3"), () => 0.5)), "2d6-3 → [4, 4] -3 = **5**");
  assert.equal(formatRoll(rollDice(specFor("d20"), () => 0.5)), "1d20 → [11] = **11**");
});

test("rolls stay within range across the whole face of a die", () => {
  const spec = specFor("100d1000");
  for (const random of [() => 0, () => 0.999999999, Math.random]) {
    const { rolls } = rollDice(spec, random);
    assert.equal(rolls.length, 100);
    for (const roll of rolls) {
      assert.ok(Number.isInteger(roll) && roll >= 1 && roll <= 1000, `out of range: ${roll}`);
    }
  }
});
