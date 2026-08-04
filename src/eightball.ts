/**
 * The Magic 8-Ball's answers and reply formatting. Deliberately free of
 * imports.
 *
 * The question arrives straight from Discord, so formatting lives outside the
 * command handler where the suite can test the echo without booting config
 * (which exits the process when secrets are absent, including in CI).
 */

/** Longest question we'll echo back; anything past this is elided. */
export const MAX_QUESTION_LENGTH = 200;

/**
 * The twenty answers printed on a real Magic 8-Ball: ten affirmative, five
 * non-committal, five negative. Kept in that order and in one array so the
 * uniform pick reproduces the toy's actual odds.
 */
export const ANSWERS = [
  "It is certain.",
  "It is decidedly so.",
  "Without a doubt.",
  "Yes definitely.",
  "You may rely on it.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Yes.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
] as const;

export type Answer = (typeof ANSWERS)[number];

/** `random` is injectable so tests can pin the outcome. */
export function pickAnswer(random: () => number = Math.random): Answer {
  return ANSWERS[Math.floor(random() * ANSWERS.length)]!;
}

/**
 * Discord renders the echoed question as-is, so collapse whitespace and strip
 * the characters that would let a question forge formatting or a mention.
 */
function sanitiseQuestion(question: string): string {
  const collapsed = question.replace(/\s+/g, " ").trim();
  const truncated =
    collapsed.length > MAX_QUESTION_LENGTH
      ? `${collapsed.slice(0, MAX_QUESTION_LENGTH - 1)}…`
      : collapsed;
  return truncated.replace(/[`*_~|\\<>@]/g, "");
}

export function formatAnswer(question: string, answer: Answer): string {
  const asked = sanitiseQuestion(question);
  // A question that sanitises to nothing still deserves an answer.
  return asked === "" ? `🎱 ${answer}` : `🎱 "${asked}" → **${answer}**`;
}
