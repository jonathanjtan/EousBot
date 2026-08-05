import type { UsageWindow } from "./usage.js";

/**
 * Deciding when a Claude usage window has rolled over, and what to say about it.
 *
 * Only types and pure functions live here, for the same reason usage.ts is
 * split that way: the suite can exercise the rollover logic without booting
 * config or opening a Claude session. The polling loop is usagewatch.ts.
 */

/** What we remembered about one window the last time we looked. */
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

export interface ResetEvent {
  label: string;
  /** Utilization observed just before the window rolled over. */
  previousUtilization: number | null;
}

/**
 * Compares a fresh reading against the remembered one and reports the windows
 * that have since reset.
 *
 * A window has reset when the server hands back a *different* reset timestamp
 * and the one we were holding is now in the past. Comparing timestamps rather
 * than watching utilization drop avoids firing on the ordinary case of a
 * window whose usage was recalculated downwards.
 */
export function diffResets(
  previous: ResetMemory,
  windows: UsageWindow[],
  now: number,
): { events: ResetEvent[]; next: ResetMemory } {
  const events: ResetEvent[] = [];
  const next: ResetMemory = {};

  for (const window of windows) {
    if (!window.resetsAt || Number.isNaN(Date.parse(window.resetsAt))) continue;

    const before = previous[window.label];
    if (
      before &&
      before.resetsAt !== window.resetsAt &&
      Date.parse(before.resetsAt) <= now &&
      (before.utilization ?? 0) >= REMIND_THRESHOLD
    ) {
      events.push({ label: window.label, previousUtilization: before.utilization });
    }

    next[window.label] = { resetsAt: window.resetsAt, utilization: window.utilization };
  }

  // Windows the API stopped reporting are dropped rather than carried forward:
  // a stale entry would fire a phantom reset if the label ever came back.
  return { events, next };
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
