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
/**
 * A conversational run, held apart from the build above.
 *
 * One slot was enough while chat had two web tools and a ceiling of eight
 * turns. It is not enough now that a question can take thirty turns with a
 * shell: chat has to be stoppable, and sharing the slot would mean a question
 * asked mid-build overwrites the build's handle and leaves it unstoppable.
 */
let currentChat: Stoppable | null = null;
let stoppedDeliberately = false;

export function setRunning(q: Stoppable | null): void {
  current = q;
  if (q) stoppedDeliberately = false;
}

export function setRunningChat(q: Stoppable | null): void {
  currentChat = q;
  if (q) stoppedDeliberately = false;
}

export function isRunning(): boolean {
  return current !== null;
}

export function isChatRunning(): boolean {
  return currentChat !== null;
}

/**
 * Interrupts the running agent. Returns false when there was nothing to stop.
 *
 * The flag matters downstream: an interrupted run surfaces as a generic
 * failure, and reporting "the build failed" to whoever just asked for it to
 * stop is needlessly alarming.
 */
export async function stopRunning(): Promise<boolean> {
  // The build first: it is the one with money and a pull request riding on it,
  // and a chat run costs less to leave alone for another few seconds.
  const target = current ?? currentChat;
  if (!target) return false;
  stoppedDeliberately = true;
  try {
    await target.interrupt();
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
