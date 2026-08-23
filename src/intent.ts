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
 * `chat` is now the default, and the rest are the special cases. That is a
 * reversal, and it was earned: while chat had two web tools the fall-through
 * was `revise`, which meant "fetch me the latest threads off /vt/" resolved to
 * a pull request and answered "there are no open pull requests to act on".
 * Five of six ordinary requests misrouted that way.
 *
 * Two causes, both fixed here. The fall-through was backwards for a bot whose
 * main job is now answering; and REVISION_MARKERS is a list of ordinary
 * English verbs -- add, use, change, remove, move -- that collide with almost
 * any task someone would ask for. "add subtitles to this clip" is not feedback
 * on a pull request.
 *
 * So the review path now requires *positive evidence* that a pull request is
 * involved: a reply to one of the bot's own review messages, an explicit `#11`,
 * or approve/reject vocabulary that means nothing outside a review. Absent
 * that, it is a request, and the agent handles it. The cost asymmetry points
 * this way too: reading a task as feedback spends a build and opens a pull
 * request nobody wanted, while reading feedback as a task costs one retype.
 * The PR workflow keeps three unambiguous entrances -- the Request changes
 * button, `/revise`, and replying to the review embed.
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
  /**
   * The message replies to one of the bot's *review* messages -- one naming a
   * PR, not merely one the bot sent.
   *
   * The distinction matters now that the bot holds conversations: replying to
   * an answer to ask a follow-up is the most natural thing there is, and
   * treating every reply as review context sent those to the revision path.
   */
  replyingToReview?: boolean;
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

  // Positive evidence that a pull request is involved. Approval and rejection
  // words count on their own: neither has any meaning outside a review, so a
  // message carrying one is about a PR even when it names no number.
  const aboutPr =
    context.replyingToReview === true ||
    PR_REFERENCE.test(text) ||
    APPROVE_PATTERNS.test(text) ||
    REJECT_PATTERNS.test(text);

  // No evidence, so it is a request rather than feedback. This is the common
  // case and the reason the parser exists in this shape -- see the note above.
  if (!aboutPr) return { kind: "chat", text };

  // Below here the message is about a pull request, and the original ordering
  // applies unchanged: revision markers are checked before approval words, so
  // an approval word inside a change request cannot win. Failing toward
  // `revise` costs a build; failing toward `approve` deploys something nobody
  // agreed to.
  if (REVISION_MARKERS.test(text)) return { kind: "revise", feedback: text };

  if (APPROVE_PATTERNS.test(text)) return { kind: "approve" };
  if (REJECT_PATTERNS.test(text)) return { kind: "reject", reason: text };

  // Named a PR but said nothing classifiable about it. Feedback is the safe
  // reading: it is the reversible one, and approval still wants a button.
  return { kind: "revise", feedback: text };
}
