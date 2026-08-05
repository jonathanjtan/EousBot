import type { Client, TextChannel } from "discord.js";
import { config } from "./config.js";
import { log } from "./log.js";
import {
  MISSED_RESET_GRACE_MS,
  dueResets,
  formatReminder,
  nextResetAt,
  rememberWindows,
} from "./reminders.js";
import { readResetMemory, saveResetMemory, usageReminderSubscribers } from "./state.js";
import type { UsageWindow } from "./usage.js";

/**
 * Pings whoever asked to hear about a Claude usage reset. Subscriptions are
 * managed by /remindme.
 *
 * Nothing here polls. Every usage reading already carries the reset times, so
 * fetchUsage hands its windows to noteUsageSnapshot, which memoizes them and
 * arms one timer for the earliest reset worth announcing. Between readings the
 * bot asks Claude nothing at all.
 */

/** setTimeout stores its delay in a signed 32-bit int; anything longer wraps. */
const MAX_TIMER_MS = 2_147_483_647;

let client: Client | null = null;
let timer: NodeJS.Timeout | null = null;

/** Called once the gateway is up, to honour reset times remembered before a restart. */
export function startUsageResetWatch(ready: Client): void {
  client = ready;
  arm();
}

/** Records the reset times from a usage reading, wherever it came from. */
export function noteUsageSnapshot(windows: UsageWindow[]): void {
  saveResetMemory(rememberWindows(windows));
  arm();
}

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!client) return;

  const at = nextResetAt(readResetMemory());
  if (at === null) return;

  // Past-due resets are handled through the timer rather than inline: fire()
  // calls arm() again, and going through the event loop keeps that from
  // recursing when several windows are due at once.
  const delay = Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS);
  timer = setTimeout(() => {
    void fire();
  }, delay);
  // The bot restarts itself; a pending timer must not hold the process open.
  timer.unref();
}

async function fire(): Promise<void> {
  timer = null;

  const { events, remaining } = dueResets(
    readResetMemory(),
    Date.now(),
    MISSED_RESET_GRACE_MS,
  );
  // Recorded before delivery: a Discord outage should cost one notification,
  // not leave a due reset in memory to fire again on the next arming.
  saveResetMemory(remaining);
  // Re-armed for whatever is next before the send, which can be slow.
  arm();

  if (events.length === 0) return;

  const subscribers = usageReminderSubscribers();
  if (subscribers.length === 0) return;

  log.info("Usage windows reset", {
    windows: events.map((e) => e.label).join(", "),
    subscribers: subscribers.length,
  });
  await announceReset(formatReminder(events, subscribers));
}

/**
 * Delivered as a channel message rather than DMs: the mentions are the point,
 * and a bot DM to a user who shares no other context with it is the kind of
 * thing Discord rate-limits hard.
 */
async function announceReset(text: string): Promise<void> {
  try {
    const channel = await client?.channels.fetch(config.discord.channelId);
    if (channel?.isTextBased() && "send" in channel) {
      await (channel as TextChannel).send(text);
    }
  } catch (err) {
    log.warn("Could not deliver usage reset reminder", { err: String(err) });
  }
}
