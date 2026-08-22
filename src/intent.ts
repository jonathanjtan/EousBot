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
 *
 * `chat` is the one branch that leads nowhere near the repository: it answers
 * a question and stops. Because it cannot cost anything but a reply, it is
 * allowed to win ahead of the revision markers -- see the ordering below.
 */

export type MentionIntent =
  | { kind: "approve" }
  | { kind: "reject"; reason: string }
  | { kind: "revise"; feedback: string }
  | { kind: "build"; issueNumber: number }
  | { kind: "chat"; text: string }
  | { kind: "help" };

/**
 * What the parser knows about a message beyond its text. Plain data rather
 * than a discord.js Message, so this module stays import-free.
 */
export interface MentionContext {
  /** The message replies to one of the bot's own -- nearly always a review embed. */
  replyingToBot?: boolean;
  /** The message carries at least one image attachment. */
  hasImage?: boolean;
}

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

/** Anything that ties a message to a pull request rather than to a topic. */
const PR_REFERENCE = /#\d+|\bpr\s+\d+/i;

/** Conversational lead-ins, stripped before the openers below are tested. */
const FILLER = "(?:(?:hey|hi|hello|yo|ok|okay|so|um|uh|quick question|question)[,:\\s]+)*";

/**
 * Openers that mark a message as a question put *to* the bot rather than an
 * instruction *about* its code.
 *
 * Only unambiguous interrogatives and requests for information are listed.
 * Bare modals are deliberately absent: "can you rename the module" is a
 * revision and "can you tell me the exchange rate" is a question, so the modal
 * qualifies only when an information verb follows it.
 */
const QUESTION_OPENERS = new RegExp(
  "^" +
    FILLER +
    "(?:" +
    "(?:can|could|would|will)\\s+you\\s+(?:tell|explain|describe|define|translate|summari[sz]e|identify|list|name)\\b" +
    "|(?:what|whats|who|whose|whom|where|when|why|which|how)\\b" +
    "|(?:tell me|explain|describe|define|translate|summari[sz]e|identify)\\b" +
    ")",
  "i",
);

/**
 * "work on #16" -- asking for a build of an open feature request.
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

export function parseMentionIntent(
  rawContent: string,
  context: MentionContext = {},
): MentionIntent {
  const text = stripMentions(rawContent);

  // An uncaptioned image is a question about the image, not a bare mention.
  if (!text) return context.hasImage ? { kind: "chat", text: "" } : { kind: "help" };
  if (HELP_PATTERNS.test(text)) return { kind: "help" };

  // Ahead of the revision check, since "please build #7" carries a revision
  // marker but names an issue outright. The pattern's anchoring is what keeps
  // that from swallowing ordinary feedback.
  const build = text.match(BUILD_PATTERNS);
  if (build?.[1]) return { kind: "build", issueNumber: Number(build[1]) };

  // Whether the message concerns a pull request at all. Approval and rejection
  // words count on their own: neither has any meaning outside a review, so a
  // message carrying one is about a PR even when it names no number.
  const aboutPr =
    context.replyingToBot === true ||
    PR_REFERENCE.test(text) ||
    APPROVE_PATTERNS.test(text) ||
    REJECT_PATTERNS.test(text);

  if (!aboutPr) {
    // Both of these beat the revision markers, because a question that happens
    // to contain one ("can you explain why X") is still a question, and the
    // cost of getting it wrong runs the other way here: reading chat as a
    // revision spends a build and opens a pull request nobody wanted, while
    // reading a revision as chat costs one reply and a retype.
    if (context.hasImage) return { kind: "chat", text };
    if (QUESTION_OPENERS.test(text)) return { kind: "chat", text };

    // A trailing question mark is weaker evidence -- "drop the polling?" is
    // feedback -- so it yields to the markers rather than beating them.
    if (text.endsWith("?") && !REVISION_MARKERS.test(text)) return { kind: "chat", text };
  }

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
