import type { Client, TextChannel } from "discord.js";
import { config } from "./config.js";
import {
  type FeedEntry,
  type FeedSource,
  formatDrop,
  matches,
  nextDelayMs,
  parseFeed,
  rememberSeen,
  shouldPause,
  unseen,
} from "./feed.js";
import { log } from "./log.js";
import { readFeedWatches, readSeenEntries, saveSeenEntries } from "./state.js";

/**
 * Polls the configured drop feeds and relays matching posts into Discord.
 *
 * One timer for all sources rather than one per source: the feeds are few, the
 * interval is minutes, and a single loop makes the rate-limit backoff a single
 * piece of state instead of something to reconcile across timers.
 *
 * The decision logic -- parsing, matching, dedupe, backoff -- is in feed.ts
 * where the suite can reach it. This file owns timers, sockets, and the gateway.
 */

/** setTimeout stores its delay in a signed 32-bit int; anything longer wraps. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Reddit asks unauthenticated readers to identify themselves, and rate-limits
 * anything that doesn't far more aggressively than something that does.
 */
const UA = "EousBot/0.1 (Discord drop relay; +https://github.com/jonathanjtan/EousBot)";

let client: Client | null = null;
let timer: NodeJS.Timeout | null = null;
let consecutiveBlocks = 0;
/** Set once the first poll completes, so /restock sources can report health. */
let lastPollAt: number | null = null;
let lastError: string | null = null;

export function startFeedWatch(ready: Client): void {
  client = ready;
  if (!config.target.enabled) return;
  arm(0);
}

export interface FeedHealth {
  lastPollAt: number | null;
  lastError: string | null;
  consecutiveBlocks: number;
  sources: FeedSource[];
}

export function feedHealth(): FeedHealth {
  return { lastPollAt, lastError, consecutiveBlocks, sources: config.target.feeds };
}

function arm(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void poll();
  }, Math.min(Math.max(0, delay), MAX_TIMER_MS));
  // The bot restarts itself; a pending poll must not hold the process open.
  timer.unref();
}

async function fetchFeed(source: FeedSource): Promise<{ status: number; xml: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { "user-agent": UA, accept: "application/atom+xml, application/rss+xml, */*" },
    });
    return { status: res.status, xml: await res.text() };
  } finally {
    clearTimeout(timeout);
  }
}

async function poll(): Promise<void> {
  timer = null;

  const watches = readFeedWatches();
  if (watches.length === 0) {
    // Nothing subscribed: stay armed but don't generate traffic for nobody.
    arm(nextDelayMs(0, config.target.poll));
    return;
  }

  let blocked = false;
  const fresh: { entry: FeedEntry; source: FeedSource }[] = [];

  for (const source of config.target.feeds) {
    try {
      const { status, xml } = await fetchFeed(source);
      if (status === 429 || status === 403) {
        blocked = true;
        log.warn("Feed rate-limited", { source: source.name, status });
        continue;
      }
      if (status !== 200) {
        log.warn("Feed returned an unexpected status", { source: source.name, status });
        continue;
      }
      for (const entry of parseFeed(xml)) fresh.push({ entry, source });
    } catch (err) {
      lastError = `${source.name}: ${String(err)}`;
      log.warn("Feed fetch threw", { source: source.name, err: String(err) });
    }
  }

  if (blocked) {
    consecutiveBlocks += 1;
    lastError = `rate-limited (${consecutiveBlocks} in a row)`;
    if (shouldPause(consecutiveBlocks, config.target.poll)) {
      log.error("Feed polling paused after repeated rate limiting", { consecutiveBlocks });
      // Deliberately still re-armed, at the ceiling delay: unlike a CAPTCHA, a
      // rate limit does clear on its own, so giving up entirely would turn a
      // temporary block into a permanently dead feature.
    }
    arm(nextDelayMs(consecutiveBlocks, config.target.poll));
    return;
  }

  consecutiveBlocks = 0;
  lastPollAt = Date.now();
  if (fresh.length > 0) lastError = null;

  const seen = readSeenEntries();
  const newOnes = unseen(
    fresh.map((f) => f.entry),
    seen,
  );

  // Recorded before delivery: a Discord outage should cost one notification,
  // not leave entries queued to replay on the next poll.
  saveSeenEntries(rememberSeen(seen, newOnes));

  // On the very first poll after a fresh install, `seen` is empty and every
  // entry in the feed looks new. Relaying 25 old posts as if they were drops
  // would be the loudest possible first impression, so the first pass only
  // primes the dedupe list.
  if (seen.length === 0) {
    log.info("Primed feed dedupe on first poll", { entries: newOnes.length });
    arm(nextDelayMs(0, config.target.poll));
    return;
  }

  for (const { entry, source } of fresh) {
    if (!newOnes.some((n) => n.id === entry.id)) continue;
    for (const watch of watches) {
      if (!matches(entry, watch.keyword)) continue;
      log.info("Feed match", { keyword: watch.keyword, title: entry.title.slice(0, 80) });
      await say(watch.channelId, formatDrop(watch, entry, source));
    }
  }

  arm(nextDelayMs(0, config.target.poll));
}

/** Runs one poll immediately, for `/restock sources` to report against. */
export async function pollNow(): Promise<void> {
  if (timer) clearTimeout(timer);
  await poll();
}

async function say(channelId: string, text: string): Promise<void> {
  try {
    const channel = await client?.channels.fetch(channelId || config.discord.channelId);
    if (channel?.isTextBased() && "send" in channel) {
      await (channel as TextChannel).send(text);
    }
  } catch (err) {
    log.warn("Could not deliver drop alert", { err: String(err) });
  }
}
