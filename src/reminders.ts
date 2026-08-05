import type { UsageWindow } from "./usage.js";

/**
 * What the bot remembers about when its Claude usage windows reset, and what
 * to say once one has.
 *
 * The reset times arrive with every usage reading, so nothing here has to go
 * looking for them: whatever last read the limits memoizes what it saw, and a
 * single timer is armed for the earliest reset worth mentioning. Only types
 * and pure functions live here, for the same reason usage.ts is split that
 * way -- the suite can exercise this without booting config. Arming the timer
 * is usagewatch.ts.
 */

/** What we remembered about one window the last time anything read the limits. */
export interface WindowMemory {
  /** ISO 8601 reset timestamp as reported then. */
  resetsAt: string;
  utilization: number | null;
}

/** Keyed by window label -- the same labels /usage displays. */
export type ResetMemory = Record<string, WindowMemory>;

/**
 * How full a window has to have been for its reset to be worth a ping.
 *
 * Without this the 5-hour window would notify every five hours regardless of
 * whether anyone was ever blocked by it, which is exactly the kind of noise
 * that gets a bot muted.
 */
export const REMIND_THRESHOLD = 50;

/**
 * How late a reset can be delivered before it's stale news.
 *
 * The bot restarts itself, and a reset that fell inside a long outage is worth
 * nothing to the person who was waiting on it hours ago.
 */
export const MISSED_RESET_GRACE_MS = 60 * 60_000;

export interface ResetEvent {
  label: string;
  /** Utilization observed the last time the limits were read before the reset. */
  previousUtilization: number | null;
}

/** Distils a usage reading into what has to survive until the reset lands. */
export function rememberWindows(windows: UsageWindow[]): ResetMemory {
  const memory: ResetMemory = {};
  for (const window of windows) {
    // A window with no usable reset time can't be scheduled against, so it is
    // simply not remembered.
    if (!window.resetsAt || Number.isNaN(Date.parse(window.resetsAt))) continue;
    memory[window.label] = { resetsAt: window.resetsAt, utilization: window.utilization };
  }
  return memory;
}

/**
 * Splits the memory into the resets that have now landed and the ones still
 * ahead.
 *
 * Every entry whose moment has passed leaves `remaining`, whether or not it
 * earned a ping -- a memory that never shrinks would re-arm the timer on a
 * reset it has already handled.
 */
export function dueResets(
  memory: ResetMemory,
  now: number,
  staleAfterMs: number,
): { events: ResetEvent[]; remaining: ResetMemory } {
  const events: ResetEvent[] = [];
  const remaining: ResetMemory = {};

  for (const [label, entry] of Object.entries(memory)) {
    const at = Date.parse(entry.resetsAt);
    if (at > now) {
      remaining[label] = entry;
      continue;
    }
    if ((entry.utilization ?? 0) >= REMIND_THRESHOLD && now - at <= staleAfterMs) {
      events.push({ label, previousUtilization: entry.utilization });
    }
  }

  return { events, remaining };
}

/**
 * When the next ping is owed, as epoch milliseconds, or null if no remembered
 * window was full enough to be worth one.
 */
export function nextResetAt(memory: ResetMemory): number | null {
  const times = Object.values(memory)
    .filter((entry) => (entry.utilization ?? 0) >= REMIND_THRESHOLD)
    .map((entry) => Date.parse(entry.resetsAt));
  return times.length === 0 ? null : Math.min(...times);
}

/** The message the subscribers get, mentions included. */
export function formatReminder(events: ResetEvent[], subscribers: string[]): string {
  const which = events
    .map(
      (e) =>
        `• **${e.label}** — was at ${e.previousUtilization === null ? "an unknown level" : `${Math.round(e.previousUtilization)}%`}, now reset`,
    )
    .join("\n");
  const mentions = subscribers.map((id) => `<@${id}>`).join(" ");
  return [`${mentions} Claude usage has reset.`, which].join("\n");
}
