import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";
import type { FeedWatch } from "./feed.js";
import type { ResetMemory } from "./reminders.js";

/**
 * A tiny JSON-file store for the handful of facts that must survive a restart.
 *
 * The bot restarts itself as part of normal operation, so anything it wants to
 * say *about* a deploy has to outlive the process that performed it. Deliberately
 * not SQLite: a native module would have to compile on the VM during cloud-init,
 * and the entire dataset here is a few dozen bytes.
 */

export interface PendingAnnouncement {
  /** Channel to post the post-restart message into. */
  channelId: string;
  prNumber: number;
  issueNumber: number | null;
  title: string;
  /** Commit the bot expects to be running once it comes back up. */
  expectedSha: string;
  approvedBy: string;
  at: string;
}

/**
 * Work the process was doing when it died.
 *
 * Written when an agent run starts and cleared when it finishes, so a claim
 * still present at boot means the previous process was killed mid-run --
 * almost always by a deploy restarting the service. Without this the Discord
 * message just freezes at its last progress edit and nothing ever says why.
 */
export interface InterruptedWork {
  kind: "build" | "revise";
  target: number;
  startedBy: string;
  channelId: string | null;
  at: string;
}

interface StateShape {
  pendingAnnouncement: PendingAnnouncement | null;
  inFlight: InterruptedWork | null;
  /** Discord user IDs that asked to be pinged when a usage window resets. */
  usageReminders: string[];
  /** Last-seen reset timestamps, so a restart doesn't replay old rollovers. */
  resetMemory: ResetMemory;
  /**
   * Keyword subscriptions against the drop feeds.
   *
   * On disk rather than in memory for the usual reason: the bot restarts
   * itself, and a watch set up the night before a morning drop has to survive
   * whatever deploys happen in between or it silently isn't watching when it
   * matters.
   */
  feedWatches: FeedWatch[];
  /**
   * Feed entry ids already relayed.
   *
   * Also on disk, and for a sharper reason: without it a self-deploy landing
   * mid-drop would replay the last 25 posts into the channel.
   */
  seenEntries: string[];
}

const EMPTY: StateShape = {
  pendingAnnouncement: null,
  inFlight: null,
  usageReminders: [],
  resetMemory: {},
  feedWatches: [],
  seenEntries: [],
};

const statePath = join(config.runtime.repoPath, "state", "eousbot.json");

function read(): StateShape {
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(statePath, "utf8")) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("State file unreadable, starting fresh", { err: String(err) });
    }
    return { ...EMPTY };
  }
}

function write(next: StateShape): void {
  mkdirSync(dirname(statePath), { recursive: true });
  // Write-then-rename: a restart racing a half-written file would otherwise
  // lose the very announcement the restart exists to deliver.
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, statePath);
}

export function setPendingAnnouncement(a: PendingAnnouncement): void {
  write({ ...read(), pendingAnnouncement: a });
}

export function setInFlight(work: InterruptedWork | null): void {
  write({ ...read(), inFlight: work });
}

/** Reads and clears in one step: an orphan is reported once, not every boot. */
export function takeInterruptedWork(): InterruptedWork | null {
  const current = read();
  if (!current.inFlight) return null;
  write({ ...current, inFlight: null });
  return current.inFlight;
}

/** Reads and clears in one step, so a crash loop can't spam the channel. */
export function takePendingAnnouncement(): PendingAnnouncement | null {
  const current = read();
  if (!current.pendingAnnouncement) return null;
  write({ ...current, pendingAnnouncement: null });
  return current.pendingAnnouncement;
}

export function usageReminderSubscribers(): string[] {
  return read().usageReminders;
}

/** Adds or removes the user, and reports whether they're subscribed afterwards. */
export function toggleUsageReminder(userId: string): boolean {
  const current = read();
  const subscribed = current.usageReminders.includes(userId);
  const usageReminders = subscribed
    ? current.usageReminders.filter((id) => id !== userId)
    : [...current.usageReminders, userId];
  write({ ...current, usageReminders });
  return !subscribed;
}

export function readResetMemory(): ResetMemory {
  return read().resetMemory;
}

export function saveResetMemory(resetMemory: ResetMemory): void {
  write({ ...read(), resetMemory });
}

export function readFeedWatches(): FeedWatch[] {
  return read().feedWatches;
}

/** Adds the watch, or replaces the existing one for the same keyword. */
export function upsertFeedWatch(watch: FeedWatch): void {
  const current = read();
  const key = watch.keyword.toLowerCase();
  write({
    ...current,
    feedWatches: [...current.feedWatches.filter((w) => w.keyword.toLowerCase() !== key), watch],
  });
}

/** Reports whether anything was actually removed, so the reply can say so. */
export function removeFeedWatch(keyword: string): boolean {
  const current = read();
  const key = keyword.toLowerCase();
  const remaining = current.feedWatches.filter((w) => w.keyword.toLowerCase() !== key);
  if (remaining.length === current.feedWatches.length) return false;
  write({ ...current, feedWatches: remaining });
  return true;
}

export function readSeenEntries(): string[] {
  return read().seenEntries;
}

export function saveSeenEntries(seenEntries: string[]): void {
  write({ ...read(), seenEntries });
}
