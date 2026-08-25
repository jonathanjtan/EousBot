import type { Character, GameState } from "./types.js";

/**
 * Telling people their adventure is done.
 *
 * This should have existed from the first commit of the dispatch game and did
 * not. The loop is "choose, leave, come back", and the third step was left
 * entirely to the player's memory -- you either happened to check `/idlerpg
 * status` at the right moment or your character sat finished for hours. A game
 * built around walking away has to be the thing that tells you to walk back.
 *
 * Pure, so the suite can test the selection logic without a gateway. Delivery
 * is idlerpg/notifywatch.ts.
 */

/**
 * Characters whose adventure has finished and who have not been told.
 *
 * Reading rather than mutating, so a caller that fails to deliver can try
 * again on the next pass instead of silently swallowing the one reminder.
 */
export function pendingClaims(state: GameState, now: number): Character[] {
  return Object.values(state.characters).filter(
    (c) => c.expedition !== null && now >= c.expedition.endsAt && !c.expedition.notified,
  );
}

/** Marks a character as told. Safe to call on someone who has since claimed. */
export function markNotified(character: Character): void {
  if (character.expedition) character.expedition.notified = true;
}

/** What the reminder says. */
export function reminder(character: Character): string {
  const difficulty = character.expedition?.difficulty ?? 0;
  return [
    `**${character.name}** is back from difficulty ${difficulty}.`,
    "`/idlerpg claim` to see how it went.",
  ].join("\n");
}
