/**
 * Reading intent from a message that mentions the bot. No imports, so tests
 * reach it without booting config.
 *
 * Deliberately heuristic rather than model-classified. Classification would be
 * more flexible, but it would put a language model in the path of deciding
 * whether to deploy code -- and the failure mode of misreading "looks good,
 * but change X" as approval is shipping unreviewed code. The rules below fail
 * toward `revise`, which is the reversible outcome, and approval is confirmed
 * with a button rather than taken from prose.
 */

export type MentionIntent =
  | { kind: "approve" }
  | { kind: "reject"; reason: string }
  | { kind: "revise"; feedback: string }
  | { kind: "build"; issueNumber: number }
  | { kind: "help" };

/**
 * Markers that the message is asking for a change, checked *before* approval
 * words so "looks good but drop the polling" reads as feedback rather than a
 * green light. This ordering is the whole safety property of the parser.
 */
const REVISION_MARKERS =
  /\b(instead|but|however|although|though|rather|actually|change|adjust|tweak|rework|redo|revise|refactor|add|remove|drop|delete|rename|split|move|use|make it|don'?t|do not|can you|could you|please|why|what if|prefer|simpler|simplify|too)\b/i;

const APPROVE_PATTERNS =
  /\b(ship it|ship this|lgtm|looks? good|looks? great|approve|approved|deploy it|deploy this|send it|merge it|merge this|go ahead|do it|yes+)\b/i;

const REJECT_PATTERNS =
  /\b(reject|scrap (it|this|that)|abandon|discard|throw (it|this) away|start over|nope|no thanks|forget it|close it)\b/i;

const HELP_PATTERNS = /^(help|\?+|what can you do|commands)$/i;

/**
 * "work on #16" — asking for a build of an open feature request.
 *
 * Anchored at the start and required to name a number right after the verb, so
 * feedback that happens to contain a build word ("looks good but build the
 * config from env, see #11") stays feedback. Failing toward `revise` here only
 * misreads which prose was meant for whom; failing the other way spends a
 * build on the wrong thing.
 */
const BUILD_PATTERNS =
  /^(?:(?:hey|ok|okay|yo|please|can you|could you|would you|go ahead and)[,\s]+)*(?:build|implement|work on|start(?: on)?|tackle|take on|pick up|fix|handle)\s+(?:the\s+)?(?:feature\s+)?(?:request|issue)?\s*#?(\d+)\b/i;

/** Strips leading/trailing mentions so the parser sees only the instruction. */
export function stripMentions(content: string): string {
  return content
    .replace(/<@!?\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseMentionIntent(rawContent: string): MentionIntent {
  const text = stripMentions(rawContent);

  if (!text || HELP_PATTERNS.test(text)) return { kind: "help" };

  // Ahead of the revision check, since "please build #7" carries a revision
  // marker but names an issue outright. The pattern's anchoring is what keeps
  // that from swallowing ordinary feedback.
  const build = text.match(BUILD_PATTERNS);
  if (build?.[1]) return { kind: "build", issueNumber: Number(build[1]) };

  // Checked before approval, on purpose: an approval word inside a change request must
  // not win. Failing toward `revise` costs a build; failing toward `approve`
  // costs a deploy of something nobody agreed to.
  if (REVISION_MARKERS.test(text)) return { kind: "revise", feedback: text };

  if (APPROVE_PATTERNS.test(text)) return { kind: "approve" };
  if (REJECT_PATTERNS.test(text)) return { kind: "reject", reason: text };

  // Substantive text that matched nothing is far more likely to be a change
  // request than anything else, and revise is the safe default.
  return { kind: "revise", feedback: text };
}
