import type { GameState, WorldEvent } from "./types.js";

/**
 * Realm-wide modifiers, in a module of their own.
 *
 * This lives apart from arena.ts for an unglamorous reason: the adventure loop
 * needs to read the active event, and arena.ts needs `find` from engine.ts, so
 * putting these two functions there made engine and arena import each other.
 * ESM tolerates that cycle because function declarations hoist, which is
 * exactly the kind of thing that works until somebody adds a constant at module
 * scope and gets `undefined` with no error to explain it.
 *
 * Types only in, no cycle out.
 */

export const EVENT_DURATION_MS = 2 * 3_600_000;

/** The running event, or null. Clears an expired one as a side effect. */
export function activeEvent(state: GameState, now: number): WorldEvent | null {
  if (!state.event) return null;
  if (now >= state.event.endsAt) {
    state.event = null;
    return null;
  }
  return state.event;
}

/** The multiplier an event applies to one axis. 1 when it does not apply. */
export function eventMultiplier(event: WorldEvent | null, axis: WorldEvent["kind"]): number {
  return event && event.kind === axis ? event.multiplier : 1;
}
