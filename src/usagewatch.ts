import type { Client, TextChannel } from "discord.js";
import { fetchUsage } from "./agent.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { diffResets, formatReminder } from "./reminders.js";
import { readResetMemory, saveResetMemory, usageReminderSubscribers } from "./state.js";

/**
 * Watches the Claude usage windows and pings whoever asked to hear about a
 * reset. Subscriptions are managed by /remindme.
 *
 * Each check opens a Claude session (fetchUsage does), so the loop is idle
 * whenever nobody is subscribed and deliberately slow when somebody is: the
 * windows being watched are five hours and seven days wide.
 */

const POLL_INTERVAL_MS = 5 * 60_000;

export function startUsageResetWatch(client: Client): void {
  const timer = setInterval(() => {
    void checkOnce(client);
  }, POLL_INTERVAL_MS);
  // The bot restarts itself; a pending timer must not hold the process open.
  timer.unref();
}

async function checkOnce(client: Client): Promise<void> {
  const subscribers = usageReminderSubscribers();
  if (subscribers.length === 0) return;

  let windows;
  try {
    windows = (await fetchUsage()).windows;
  } catch (err) {
    log.warn("Usage reset watch could not read usage", { err: String(err) });
    return;
  }

  const { events, next } = diffResets(readResetMemory(), windows, Date.now());
  // Recorded before delivery: a Discord outage should cost one notification,
  // not leave the memory stale enough to re-fire on the next poll.
  saveResetMemory(next);
  if (events.length === 0) return;

  log.info("Usage windows reset", {
    windows: events.map((e) => e.label).join(", "),
    subscribers: subscribers.length,
  });
  await announceReset(client, formatReminder(events, subscribers));
}

/**
 * Delivered as a channel message rather than DMs: the mentions are the point,
 * and a bot DM to a user who shares no other context with it is the kind of
 * thing Discord rate-limits hard.
 */
async function announceReset(client: Client, text: string): Promise<void> {
  try {
    const channel = await client.channels.fetch(config.discord.channelId);
    if (channel?.isTextBased() && "send" in channel) {
      await (channel as TextChannel).send(text);
    }
  } catch (err) {
    log.warn("Could not deliver usage reset reminder", { err: String(err) });
  }
}
