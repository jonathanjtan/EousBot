import type { Client } from "discord.js";
import { log } from "../log.js";
import { markNotified, pendingClaims, reminder } from "./notify.js";
import { save, world } from "./store.js";

/**
 * The one timer the dispatch RPG owns.
 *
 * Deliberately the only one. Everything else in this game is evaluated lazily
 * when somebody runs a command -- raids expire on inspection, tournaments close
 * on inspection -- which is why it needed no tick loop at all. Reminders are
 * the exception, because by definition nobody is looking.
 *
 * Cheap enough to leave running: a pass over a realm of a few dozen characters
 * is a filter over an array, and it does nothing whatsoever when the realm is
 * empty.
 */

const MAX_TIMER_MS = 2_147_483_647;
/** How often to look. A minute is well inside the shortest adventure. */
export const POLL_MS = 60_000;

let client: Client | null = null;
let timer: NodeJS.Timeout | null = null;

export function startClaimReminders(ready: Client): void {
  client = ready;
  arm(POLL_MS);
  log.info("RPG claim reminders started", { pollMs: POLL_MS });
}

function arm(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void sweep();
  }, Math.min(Math.max(0, delay), MAX_TIMER_MS));
  // The bot restarts itself; a pending sweep must not hold the process open.
  timer.unref();
}

async function sweep(): Promise<void> {
  timer = null;
  try {
    const state = world();
    const due = pendingClaims(state, Date.now());
    if (due.length === 0) return;

    for (const character of due) {
      try {
        const user = await client?.users.fetch(character.userId);
        await user?.send(reminder(character));
        // Marked only on a delivered DM, so a Discord hiccup costs a delay
        // rather than the reminder itself.
        markNotified(character);
      } catch (err) {
        // Closed DMs are a legitimate setting. Mark it anyway: retrying every
        // minute forever would be the loudest possible way to respect that.
        markNotified(character);
        log.debug("Could not DM a claim reminder", {
          userId: character.userId,
          err: String(err),
        });
      }
    }
    save();
    log.info("Sent claim reminders", { count: due.length });
  } catch (err) {
    log.error("Claim reminder sweep threw", { err: String(err) });
  } finally {
    arm(POLL_MS);
  }
}
