import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

/**
 * The models and effort levels /build offers, and the parsers that guard them.
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

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The effort a build runs at when neither /build nor AGENT_EFFORT picks one.
 *
 * Most feature requests here are small, and a higher level mostly buys longer
 * runs and more spend. Ask for more per build when a request warrants it.
 */
export const DEFAULT_EFFORT: EffortLevel = "medium";

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
