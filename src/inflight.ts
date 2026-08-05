import { log } from "./log.js";
import { setInFlight, type InterruptedWork } from "./state.js";

/**
 * One lock for all agent work, recorded where a restart can't erase it.
 *
 * Builds, revisions, and mention-driven revisions all drive the same worktree
 * bookkeeping in the same checkout, so they were never safe to run
 * concurrently -- they just had three separate flags pretending otherwise.
 *
 * The on-disk half exists because this bot restarts itself. A deploy SIGTERMs
 * whatever the agent was doing, the `finally` that cleans up never runs, and
 * the Discord message freezes at its last progress edit with nothing to say it
 * is dead. A claim still on disk at boot is exactly that situation, and the
 * next process can report it.
 */

export type Claim = InterruptedWork;

let current: Claim | null = null;

export function acquire(next: Claim): { ok: true } | { ok: false; held: Claim } {
  if (current) return { ok: false, held: current };
  current = next;
  setInFlight(next);
  log.debug("Claim acquired", { claim: next });
  return { ok: true };
}

export function release(): void {
  current = null;
  setInFlight(null);
}

export function held(): Claim | null {
  return current;
}

/** Description for a "wait your turn" reply, or for a restart refusal. */
export function describe(c: Claim): string {
  const what = c.kind === "build" ? `build of request #${c.target}` : `revision of PR #${c.target}`;
  return `a ${what} started by ${c.startedBy}`;
}
