import { fetchUsage } from "./agent.js";
import { isAdmin } from "./config.js";
import { log } from "./log.js";
import { OPEN_REVISION_CEILING, revisionHeadroom } from "./usage.js";
import type { UsageSnapshot } from "./usage.js";

/**
 * The usage gate on requesting changes.
 *
 * Anyone in the guild may ask for changes to an open PR; approving, deploying
 * and rejecting stay with the admins. What a non-admin cannot do is start an
 * agent run when the plan limits are already half gone -- see
 * OPEN_REVISION_CEILING in usage.ts for why.
 *
 * Both entry points return the message to refuse with, or null to let the
 * revision through.
 */

/** Reading the live figures spawns a session, so recent answers are reused. */
const CACHE_TTL_MS = 5 * 60_000;

let cached: { snapshot: UsageSnapshot; at: number } | null = null;

function refusal(reason: string): string {
  return [
    "Requesting changes runs the build agent, which burns the same Claude limits every build shares —",
    `so for non-admins it's open only while the session and weekly windows are both under ${OPEN_REVISION_CEILING}%.`,
    `Right now ${reason}.`,
    "Ask an admin to run it, or try again after the window resets.",
  ].join(" ");
}

/**
 * The authoritative check, made where the tokens are actually about to be
 * spent. The caller must already have deferred: this reads live usage, which
 * takes longer than the three seconds an interaction has to be answered in.
 *
 * A reading that fails refuses the revision. The gate is only meaningful if
 * an unanswered question counts as no headroom.
 */
export async function revisionRefusal(userId: string): Promise<string | null> {
  if (isAdmin(userId)) return null;

  let snapshot: UsageSnapshot;
  try {
    snapshot = await fetchUsage();
  } catch (err) {
    log.warn("Could not read usage for the revision gate", { err: String(err) });
    return refusal("I can't read the usage limits, so I can't confirm there's room");
  }

  cached = { snapshot, at: Date.now() };

  const headroom = revisionHeadroom(snapshot);
  return headroom.ok ? null : refusal(headroom.reason);
}

/**
 * The cheap pre-check, used before opening the modal.
 *
 * Discord will not let showModal follow a defer, so there is no time for a
 * live reading here -- only for what the last one said. Refusing on a recent
 * snapshot saves someone typing a paragraph of feedback that revisionRefusal
 * is about to throw away; anything else falls through to that check rather
 * than guessing.
 */
export function cachedRevisionRefusal(userId: string): string | null {
  if (isAdmin(userId)) return null;
  if (!cached || Date.now() - cached.at > CACHE_TTL_MS) return null;

  const headroom = revisionHeadroom(cached.snapshot);
  return headroom.ok ? null : refusal(headroom.reason);
}
