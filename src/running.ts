import { log } from "./log.js";

/**
 * A handle on the agent run currently in flight, so it can be stopped.
 *
 * docs/usage.md names "nothing stops a run early" as a cost driver in its own
 * right: builds run unattended, so a run that is visibly going nowhere still
 * bills every remaining turn, and each of those turns re-reads the whole
 * accumulated context. Interactive sessions get interrupted constantly, and
 * every interruption is turns not taken -- that is most of the interactive
 * cost advantage, and it needs nothing more than a handle and a button.
 *
 * Deliberately separate from inflight.ts. That module answers "may I start?";
 * this one answers "stop what is running". Keeping the SDK handle out of the
 * lock keeps the lock free of SDK types.
 */

export interface Stoppable {
  interrupt: () => Promise<unknown>;
}

let current: Stoppable | null = null;
let stoppedDeliberately = false;

export function setRunning(q: Stoppable | null): void {
  current = q;
  if (q) stoppedDeliberately = false;
}

export function isRunning(): boolean {
  return current !== null;
}

/**
 * Interrupts the running agent. Returns false when there was nothing to stop.
 *
 * The flag matters downstream: an interrupted run surfaces as a generic
 * failure, and reporting "the build failed" to whoever just asked for it to
 * stop is needlessly alarming.
 */
export async function stopRunning(): Promise<boolean> {
  if (!current) return false;
  stoppedDeliberately = true;
  try {
    await current.interrupt();
    log.info("Agent interrupted by request");
    return true;
  } catch (err) {
    log.warn("Interrupt failed", { err: String(err) });
    stoppedDeliberately = false;
    return false;
  }
}

/** Whether the run that just ended was stopped on purpose. */
export function wasStopped(): boolean {
  return stoppedDeliberately;
}
