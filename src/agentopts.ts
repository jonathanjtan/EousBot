import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

/**
 * The models and effort levels /claude offers, and the parsers that guard them.
 *
 * Discord validates a choice server-side, so a value that reaches the agent is
 * always one listed here -- a mistyped model ID can't waste a build. The cost
 * is that a newly released model needs an edit to this file first, which for a
 * bot that edits itself is one feature request.
 *
 * Only models that accept an effort level are listed, so no combination the
 * command can produce is rejected by the API.
 */

/** Per-build overrides. An absent field falls back to the configured default. */
export interface AgentOptions {
  model?: string;
  effort?: EffortLevel;
}

export const MODEL_CHOICES: { name: string; value: string }[] = [
  { name: "Opus 5", value: "claude-opus-5" },
  { name: "Fable 5", value: "claude-fable-5" },
  { name: "Sonnet 5", value: "claude-sonnet-5" },
  { name: "Opus 4.8", value: "claude-opus-4-8" },
];

/**
 * Adds a model the list didn't know about, at the top.
 *
 * The only caller is the startup lookup in models.ts, which asks Anthropic
 * what the newest Opus is. Command schemas are synced after that runs, so a
 * model released since the last deploy is selectable in /claude without an
 * edit to the array above. A duplicate is ignored rather than replacing the
 * hand-written name.
 */
export function offerModel(name: string, value: string): void {
  if (MODEL_CHOICES.some((c) => c.value === value)) return;
  if (MODEL_CHOICES.length >= CHOICE_LIMITS.count) return;
  MODEL_CHOICES.unshift({ name: name.slice(0, CHOICE_LIMITS.nameLength), value });
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The effort a build runs at when neither /claude nor AGENT_EFFORT picks one.
 *
 * `xhigh` is the level Anthropic recommends for coding and agentic work, and
 * it is what Claude Code itself defaults to. It costs more per build than the
 * `medium` this used to be; the trade is fewer builds that come back wrong.
 * Ask for less per build with /claude when a request is trivial.
 */
export const DEFAULT_EFFORT: EffortLevel = "xhigh";

export const EFFORT_CHOICES: { name: string; value: EffortLevel }[] = EFFORT_LEVELS.map(
  (level) => ({ name: level, value: level }),
);

/** Discord's own limits on a choice list, asserted so a bad edit fails a test. */
export const CHOICE_LIMITS = { count: 25, nameLength: 100, valueLength: 100 } as const;

export function parseModel(raw: string | null): string | undefined {
  return MODEL_CHOICES.find((c) => c.value === raw)?.value;
}

export function parseEffort(raw: string | null): EffortLevel | undefined {
  return EFFORT_LEVELS.find((level) => level === raw);
}

/** How a build's agent settings read in Discord and in the pull request body. */
export function describeAgentOptions(model: string, effort: EffortLevel | null): string {
  return effort ? `${model}, ${effort} effort` : model;
}
