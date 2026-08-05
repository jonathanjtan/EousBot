import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";

/**
 * Shape and formatting for the Claude plan rate limits the build agent runs
 * against -- the same numbers `/usage` shows inside Claude Code.
 *
 * Only types and pure functions live here, so the suite can exercise the
 * rendering without booting config (which exits the process when secrets are
 * absent). Reading the live figures is agent.ts's fetchUsage.
 */

export type RateLimits = NonNullable<SDKControlGetUsageResponse["rate_limits"]>;

export interface UsageWindow {
  label: string;
  /** Percentage of the window consumed, 0-100. Null when the API omitted it. */
  utilization: number | null;
  /** ISO 8601 timestamp of the reset, or null when unknown. */
  resetsAt: string | null;
}

export interface UsageSnapshot {
  /** 'pro', 'max', 'team', ... or null for API-key and third-party sessions. */
  subscriptionType: string | null;
  /** False when plan limits don't apply -- API key, Bedrock, Vertex. */
  rateLimitsAvailable: boolean;
  /** Only the windows the API actually reported, in display order. */
  windows: UsageWindow[];
}

/** The two windows any run draws down; the rest are per-model detail. */
export const SESSION_LABEL = "Current session (5h)";
export const WEEKLY_LABEL = "This week (all models)";

/** The fixed windows, in the order Claude Code lists them. */
const WINDOW_LABELS: Array<[keyof RateLimits, string]> = [
  ["five_hour", SESSION_LABEL],
  ["seven_day", WEEKLY_LABEL],
  ["seven_day_opus", "This week (Opus)"],
  ["seven_day_sonnet", "This week (Sonnet)"],
];

/**
 * Flattens the rate-limit payload into a display list.
 *
 * The payload carries a lot of optional buckets, most of them null on any
 * given plan; only the ones with something to say are kept.
 */
export function collectWindows(limits: RateLimits | null): UsageWindow[] {
  if (!limits) return [];

  const windows: UsageWindow[] = [];
  for (const [key, label] of WINDOW_LABELS) {
    const window = limits[key];
    // The per-window entries are all `{utilization, resets_at} | null`; the
    // additive buckets on this payload are shaped differently, and `resets_at`
    // is what tells them apart.
    if (!window || typeof window !== "object" || !("resets_at" in window)) continue;
    windows.push({
      label,
      utilization: window.utilization ?? null,
      resetsAt: window.resets_at ?? null,
    });
  }

  // Per-model weekly windows are additive -- the server names them itself.
  for (const scoped of limits.model_scoped ?? []) {
    windows.push({
      label: `This week (${scoped.display_name})`,
      utilization: scoped.utilization ?? null,
      resetsAt: scoped.resets_at ?? null,
    });
  }

  return windows;
}

const BAR_WIDTH = 20;

/** A text meter, because Discord embeds have no progress bar of their own. */
export function formatBar(utilization: number | null): string {
  if (utilization === null) return "`" + "░".repeat(BAR_WIDTH) + "` —";
  const pct = Math.min(100, Math.max(0, utilization));
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  return "`" + "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled) + `\` ${Math.round(pct)}%`;
}

/**
 * One window as an embed field body: the meter, then when it resets.
 *
 * Resets are rendered as a Discord relative timestamp so the reader sees it in
 * their own clock rather than the server's.
 */
export function formatWindow(window: UsageWindow): string {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const when = Number.isNaN(reset)
    ? "reset time unknown"
    : `resets <t:${Math.floor(reset / 1000)}:R>`;
  return `${formatBar(window.utilization)} · ${when}`;
}

/** Green under half, amber approaching the cap, red once it's effectively gone. */
export function usageColour(windows: UsageWindow[]): number {
  const peak = Math.max(0, ...windows.map((w) => w.utilization ?? 0));
  if (peak >= 90) return 0xd7263d;
  if (peak >= 50) return 0xe0a458;
  return 0x2f9e44;
}

/**
 * Human name for the account behind the limits.
 *
 * Plan limits are absent whenever the agent authenticates with an API key or a
 * third-party provider, where spend is metered per token instead.
 */
export function describePlan(snapshot: UsageSnapshot): string {
  if (!snapshot.rateLimitsAvailable) {
    return "No plan rate limits apply to this account — the agent bills per token.";
  }
  const plan = snapshot.subscriptionType;
  const named = plan ? `Claude ${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : "Claude";
  return `${named} — limits shared with everything else this machine runs.`;
}

/**
 * How full a window may be before a non-admin revision is turned away.
 *
 * Requesting changes is open to everyone, but it starts an agent run on the
 * same plan limits every build draws on, and the person starting it is not
 * the person who can approve the result. Reserving the top of each window for
 * admins keeps an enthusiastic reviewer from spending the week's budget on
 * work nobody has agreed to merge.
 */
export const OPEN_REVISION_CEILING = 60;

export type RevisionHeadroom = { ok: true } | { ok: false; reason: string };

/**
 * Whether a non-admin may start a revision right now.
 *
 * Both gated windows have to be readable and under the ceiling. Anything the
 * API declines to report is treated as no headroom rather than as headroom:
 * the failure mode of guessing wrong here is burning limits an admin was
 * saving, which is exactly what the gate exists to prevent.
 */
export function revisionHeadroom(snapshot: UsageSnapshot): RevisionHeadroom {
  if (!snapshot.rateLimitsAvailable) {
    return {
      ok: false,
      reason: "this account reports no plan limits, so there is no headroom to read",
    };
  }

  const gated = snapshot.windows.filter(
    (w) => w.label === SESSION_LABEL || w.label === WEEKLY_LABEL,
  );
  if (gated.length === 0) {
    return { ok: false, reason: "Claude reported no session or weekly window to check" };
  }

  const unreadable = gated.filter((w) => w.utilization === null);
  if (unreadable.length > 0) {
    return {
      ok: false,
      reason: `${unreadable.map((w) => w.label).join(" and ")} reported no figure`,
    };
  }

  const over = gated.filter((w) => (w.utilization ?? 0) >= OPEN_REVISION_CEILING);
  if (over.length > 0) {
    return {
      ok: false,
      reason: over
        .map((w) => `${w.label} is at ${Math.round(w.utilization ?? 0)}%`)
        .join(", and "),
    };
  }

  return { ok: true };
}
