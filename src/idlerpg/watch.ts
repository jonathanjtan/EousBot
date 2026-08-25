import { GatewayIntentBits, type Client, type Guild, type TextChannel } from "discord.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { setPresence, tick, type EngineContext } from "./engine.js";
import { batch } from "./format.js";
import { flush, touch, world } from "./store.js";
import type { Announcement, GameState } from "./types.js";

/**
 * The clock the realm runs on, and the only place the game meets Discord.
 *
 * Everything that decides anything is in engine.ts and rules.ts; this file owns
 * a timer, a socket and a save schedule. That division is what makes it
 * possible to run ten thousand simulated ticks in the suite without a gateway.
 */

/** setTimeout stores its delay in a signed 32-bit int; anything longer wraps. */
const MAX_TIMER_MS = 2_147_483_647;

/** Discord rejects a message over 2000 characters outright; this leaves room. */
const MESSAGE_LIMIT = 1_900;

let client: Client | null = null;
let timer: NodeJS.Timeout | null = null;
let lastSaveAt = 0;
/** Per-user, per-kind: when a throttled private notice may next be sent. */
const noticeCooldowns = new Map<string, number>();

export function context(now = Date.now()): EngineContext {
  return {
    rng: Math.random,
    now,
    tuning: config.idlerpg.tuning,
    bossName: client?.user?.username ?? "the bot",
  };
}

export function startIdleRpg(ready: Client): void {
  client = ready;
  if (!config.idlerpg.enabled) return;

  // The load is the one operation here that can fail permanently: store.ts
  // refuses to replace an unreadable save with an empty world. Catching it
  // means a corrupt realm stops the game and says so, rather than throwing
  // once per tick forever or -- far worse -- starting over in silence.
  let state;
  try {
    state = world();
  } catch (err) {
    log.error("Idle RPG could not start; the realm is left untouched", {
      err: String(err),
    });
    return;
  }

  log.info("Idle RPG started", {
    players: Object.keys(state.players).length,
    tickMs: config.idlerpg.tickMs,
    rpBase: config.idlerpg.tuning.rpBase,
    rpStep: config.idlerpg.tuning.rpStep,
  });
  lastSaveAt = Date.now();
  arm(config.idlerpg.tickMs);
}

function arm(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void run();
  }, Math.min(Math.max(0, delay), MAX_TIMER_MS));
  // The bot restarts itself; a pending tick must not hold the process open.
  timer.unref();
}

async function run(): Promise<void> {
  timer = null;
  try {
    const now = Date.now();
    const state = world(now);
    const elapsed = Math.floor(now / 1000) - state.lastTick;

    // Capped, and the cap is the whole point -- see IDLERPG_MAX_CATCHUP_S. A
    // negative delta means the clock moved backwards, which is credited as
    // nothing rather than as a rewind.
    const seconds = Math.max(0, Math.min(elapsed, config.idlerpg.maxCatchupSeconds));
    if (elapsed > config.idlerpg.maxCatchupSeconds) {
      log.warn("Idle RPG skipped uncredited downtime", {
        downSeconds: elapsed,
        creditedSeconds: seconds,
      });
    }

    const announcements = tick(state, seconds, context(now));
    if (seconds > 0) touch();

    await deliver(announcements);

    if (now - lastSaveAt >= config.idlerpg.saveIntervalMs) {
      flush();
      lastSaveAt = now;
    }
  } catch (err) {
    log.error("Idle RPG tick threw", { err: String(err) });
  } finally {
    arm(config.idlerpg.tickMs);
  }
}

/**
 * Sends what the engine produced.
 *
 * Channel lines are concatenated into as few messages as Discord will take:
 * a level-up alone is four lines, and posting each as its own message would
 * make the game unreadable and burn the channel's rate limit for no gain.
 */
export async function deliver(announcements: Announcement[]): Promise<void> {
  if (announcements.length === 0 || !client) return;

  const channelLines: string[] = [];
  for (const item of announcements) {
    if (item.to === "channel") {
      channelLines.push(item.text);
      continue;
    }
    if (item.userId) await whisper(item);
  }

  for (const chunk of batch(channelLines, MESSAGE_LIMIT)) {
    await announce(chunk);
  }
}

/**
 * A DM, unless this kind of DM was already sent recently.
 *
 * A failed DM is swallowed: closed DMs are a legitimate setting and a player
 * who has them off should still be able to play, just less informed.
 */
async function whisper(item: Announcement): Promise<void> {
  if (!item.userId) return;

  if (item.throttleKey) {
    const key = `${item.userId}:${item.throttleKey}`;
    const until = noticeCooldowns.get(key) ?? 0;
    if (Date.now() < until) return;
    noticeCooldowns.set(key, Date.now() + config.idlerpg.noticeThrottleMs);
  }

  try {
    const user = await client?.users.fetch(item.userId);
    await user?.send(item.text);
  } catch (err) {
    log.debug("Could not DM an Idle RPG notice", { userId: item.userId, err: String(err) });
  }
}

async function announce(text: string): Promise<void> {
  try {
    const channel = await client?.channels.fetch(config.idlerpg.channelId);
    if (channel?.isTextBased() && "send" in channel) {
      await (channel as TextChannel).send(text);
    }
  } catch (err) {
    log.warn("Could not deliver an Idle RPG announcement", { err: String(err) });
  }
}

/**
 * Applies a command's announcements immediately rather than waiting for the
 * next tick, so a `/idlerpg login` is echoed while the user is still looking.
 */
export async function publish(announcements: Announcement[]): Promise<void> {
  // Only when something actually happened. Every message in the guild reaches
  // here through the penalty hook, and marking the realm dirty for a message
  // sent by somebody who is not even playing would put the save file on a
  // permanent once-a-minute write cycle.
  if (announcements.length === 0) return;
  touch();
  await deliver(announcements);
}

/**
 * Whether Discord presence is what decides who is idling.
 *
 * Both halves are required, and the second is the one that bites: asking for
 * presence-driven idling without the GuildPresences intent would produce a
 * realm in which nobody is ever online and every clock is frozen, with no
 * error anywhere to explain it. Falling back to manual is the recoverable
 * failure; a silently dead game is not.
 */
export function presenceDriven(): boolean {
  if (config.idlerpg.onlineSource !== "presence") return false;
  if (!client?.options.intents.has(GatewayIntentBits.GuildPresences)) {
    log.error(
      "IDLERPG_ONLINE_SOURCE=presence needs the GuildPresences intent; " +
        "falling back to manual /idlerpg login. Add `presence` to " +
        "DISCORD_PRIVILEGED_INTENTS and enable it in the Developer Portal.",
    );
    return false;
  }
  return true;
}

/** Discord reports four statuses; three of them mean somebody is connected. */
export function isPresent(status: string | undefined): boolean {
  return status !== undefined && status !== "offline";
}

/**
 * One presence change. Called often on a busy server, so it does nothing at all
 * for the overwhelmingly common case of somebody who has never registered.
 */
export function notePresence(userId: string, present: boolean): void {
  if (!presenceDriven()) return;
  const state = world();
  if (!state.players[userId]) return;
  setPresence(state, userId, present);
  touch();
}

/**
 * Warms the guild member cache, and reconciles presence against it.
 *
 * Two jobs, deliberately not conditional on each other. The fetch is needed
 * whenever the GuildMembers intent is held, not just in presence mode:
 * discord.js will not emit GuildMemberRemove for a member it never cached, so
 * a cold cache means the `part` penalty silently never fires for exactly the
 * people most likely to trigger it -- the quiet ones.
 *
 * The reconciliation is needed because presence events only report *changes*.
 * Without it, a player who went offline during a restart keeps accruing time
 * until they next change status, which on a quiet night is never.
 */
export async function syncAllPresence(guild: Guild): Promise<void> {
  const wantsMembers = client?.options.intents.has(GatewayIntentBits.GuildMembers) ?? false;
  const wantsPresence = presenceDriven();
  if (!wantsMembers && !wantsPresence) return;

  try {
    await guild.members.fetch();
  } catch (err) {
    log.warn("Could not fetch guild members", { err: String(err) });
    // A cold cache degrades the part penalty but must not stop the game.
  }

  if (!wantsPresence) return;

  const state = world();
  const ids = Object.keys(state.players);
  if (ids.length === 0) return;

  let online = 0;
  for (const id of ids) {
    const present = isPresent(guild.members.cache.get(id)?.presence?.status);
    setPresence(state, id, present);
    if (present) online += 1;
  }
  touch();
  log.info("Idle RPG presence synced", { players: ids.length, online });
}

/** Whether a message in this channel breaks idle. See IDLERPG_PENALTY_SCOPE. */
export function inPenaltyScope(channelId: string): boolean {
  if (config.idlerpg.penaltyScope === "guild") return true;
  return channelId === config.idlerpg.channelId;
}

/** Called from the signal handlers, so a deploy never loses a partial minute. */
export function saveNow(): void {
  if (!config.idlerpg.enabled) return;
  try {
    flush(true);
  } catch (err) {
    log.error("Could not save the Idle RPG realm", { err: String(err) });
  }
}

/** The realm, for commands. Never mutate without calling touch(). */
export function realm(): GameState {
  return world();
}
