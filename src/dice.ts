/**
 * Pure dice-notation parsing, rolling, and formatting. Deliberately free of
 * imports.
 *
 * Notation arrives straight from Discord, so the parser is an allowlist that
 * rejects rather than throws, and it lives outside the command handler so the
 * suite can test it without booting config (which exits the process when
 * secrets are absent, including in CI).
 */

/** Refuse more dice than this in one roll -- the reply has to stay readable. */
export const MAX_DICE = 100;
/** Refuse a die bigger than this. */
export const MAX_SIDES = 1000;

export interface DiceSpec {
  count: number;
  sides: number;
  /** Flat adjustment applied to the sum. Zero when the notation had none. */
  modifier: number;
}

export type ParseResult =
  | { ok: true; spec: DiceSpec }
  | { ok: false; error: string };

/**
 * Digit runs are length-capped so an absurd input still parses into numbers we
 * can talk about -- `999999d999999` should hear about the limit, not be told
 * its notation is malformed.
 */
const NOTATION = /^(\d{1,9})?d(\d{1,9})(?:([+-])(\d{1,9}))?$/i;

const EXAMPLE = "`2d6+3`";

export function parseDiceNotation(input: string): ParseResult {
  const match = NOTATION.exec(input.trim());
  if (!match) {
    return { ok: false, error: `That isn't dice notation I recognise. Try ${EXAMPLE}.` };
  }

  const [, rawCount, rawSides, sign, rawModifier] = match;
  const count = rawCount === undefined ? 1 : Number(rawCount);
  const sides = Number(rawSides);
  const magnitude = rawModifier === undefined ? 0 : Number(rawModifier);
  const modifier = sign === "-" ? -magnitude : magnitude;

  if (count < 1) {
    return { ok: false, error: `Roll at least one die. Try ${EXAMPLE}.` };
  }
  if (sides < 1) {
    return { ok: false, error: `A die needs at least one side. Try ${EXAMPLE}.` };
  }
  if (count > MAX_DICE) {
    return { ok: false, error: `That's ${count} dice — I'll roll at most ${MAX_DICE} at once.` };
  }
  if (sides > MAX_SIDES) {
    return {
      ok: false,
      error: `A ${sides}-sided die is too big — the limit is ${MAX_SIDES} sides per die.`,
    };
  }

  return { ok: true, spec: { count, sides, modifier } };
}

export interface RollResult {
  spec: DiceSpec;
  rolls: number[];
  total: number;
}

/** `random` is injectable so tests can pin the outcome. */
export function rollDice(spec: DiceSpec, random: () => number = Math.random): RollResult {
  const rolls: number[] = [];
  for (let i = 0; i < spec.count; i++) {
    rolls.push(Math.floor(random() * spec.sides) + 1);
  }
  const total = rolls.reduce((sum, roll) => sum + roll, 0) + spec.modifier;
  return { spec, rolls, total };
}

/** Canonical notation, so the echo can't carry anything the parser didn't accept. */
export function formatNotation(spec: DiceSpec): string {
  const modifier = spec.modifier === 0 ? "" : spec.modifier > 0 ? `+${spec.modifier}` : `${spec.modifier}`;
  return `${spec.count}d${spec.sides}${modifier}`;
}

export function formatRoll(result: RollResult): string {
  const { spec, rolls, total } = result;
  const modifier =
    spec.modifier === 0 ? "" : spec.modifier > 0 ? ` +${spec.modifier}` : ` ${spec.modifier}`;
  return `${formatNotation(spec)} → [${rolls.join(", ")}]${modifier} = **${total}**`;
}
