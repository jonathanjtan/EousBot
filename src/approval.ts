import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

/**
 * The approval prompt: a PR summary plus the two buttons that decide its fate.
 *
 * All the context the button handler needs is encoded in the custom ID, so an
 * approval posted before a restart still works after one. Discord caps custom
 * IDs at 100 characters, which two integers and a prefix stay well within.
 */

const PREFIX = "eous";

/**
 * A second custom-ID namespace, for the "Ask EousBot" modal.
 *
 * Distinct from PREFIX so `decodeCustomId` and `decodeAskCustomId` each return
 * null for the other's IDs rather than half-parsing them. The payload is one
 * interaction ID -- what it points at lives in memory, because the message a
 * context menu was used on cannot be re-fetched. See commands/ask.ts.
 */
const ASK_PREFIX = "ask";

/** Field id inside the ask modal. */
export const QUESTION_INPUT_ID = "question";

export function encodeAskCustomId(interactionId: string): string {
  return `${ASK_PREFIX}:${interactionId}`;
}

/** The stash key inside a modal's custom ID, or null if it isn't one of ours. */
export function decodeAskCustomId(customId: string): string | null {
  const [prefix, key, extra] = customId.split(":");
  if (prefix !== ASK_PREFIX || !key || extra !== undefined) return null;
  return /^\d+$/.test(key) ? key : null;
}

export type ApprovalAction = "approve" | "reject" | "revise";

/** Field id inside the revision modal. */
export const FEEDBACK_INPUT_ID = "feedback";

export interface ApprovalTarget {
  action: ApprovalAction;
  prNumber: number;
  issueNumber: number | null;
}

export function encodeCustomId(t: ApprovalTarget): string {
  return `${PREFIX}:${t.action}:${t.prNumber}:${t.issueNumber ?? "none"}`;
}

export function decodeCustomId(customId: string): ApprovalTarget | null {
  const [prefix, action, pr, issue] = customId.split(":");
  if (prefix !== PREFIX) return null;
  if (action !== "approve" && action !== "reject" && action !== "revise") return null;

  const prNumber = Number(pr);
  if (!Number.isInteger(prNumber)) return null;

  return {
    action,
    prNumber,
    issueNumber: issue && issue !== "none" && Number.isInteger(Number(issue)) ? Number(issue) : null,
  };
}

export function buildApprovalMessage(opts: {
  prNumber: number;
  prUrl: string;
  issueNumber: number;
  title: string;
  summary: string;
  diffStat: string;
  costUsd: number | null;
  requestedBy: string | null;
}) {
  const embed = new EmbedBuilder()
    .setColor(0x1d76db)
    .setTitle(`PR #${opts.prNumber} — ${opts.title}`)
    .setURL(opts.prUrl)
    .setDescription(
      opts.summary.length > 1800 ? `${opts.summary.slice(0, 1800)}…` : opts.summary || "_no summary_",
    )
    .addFields(
      {
        name: "Changes",
        value: `\`\`\`\n${opts.diffStat.slice(0, 900) || "(none reported)"}\n\`\`\``,
      },
      { name: "Request", value: `#${opts.issueNumber}`, inline: true },
      {
        name: "Requested by",
        value: opts.requestedBy ? `<@${opts.requestedBy}>` : "unknown",
        inline: true,
      },
      {
        name: "Cost",
        value: opts.costUsd !== null ? `$${opts.costUsd.toFixed(3)}` : "n/a",
        inline: true,
      },
    )
    .setFooter({
      text: "Typecheck and tests passed. Approving merges this and restarts the bot.",
    });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({ action: "approve", prNumber: opts.prNumber, issueNumber: opts.issueNumber }),
      )
      .setLabel("Approve & deploy")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({ action: "revise", prNumber: opts.prNumber, issueNumber: opts.issueNumber }),
      )
      .setLabel("Request changes")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(
        encodeCustomId({ action: "reject", prNumber: opts.prNumber, issueNumber: opts.issueNumber }),
      )
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * The shape of an approval prompt this module can edit afterwards.
 *
 * Structural rather than discord.js's Message so the modal handler can pass
 * whatever it has -- including nothing, when the modal came from /revise
 * instead of a button -- and so a test can pass a stub.
 */
export interface EditableApprovalMessage {
  edit(options: { content: string; components: [] }): Promise<unknown>;
}

/**
 * Retires the approval prompt whose Request changes button was just used.
 *
 * A revision rewrites the PR and posts its own approval prompt, so the old
 * one's Approve button now points at a diff nobody has read. Stripping the
 * buttons leaves the embed as a record without leaving it actionable.
 *
 * Best effort: the message may have been deleted or purged, and that should
 * not fail the revision that was actually asked for.
 */
export async function closeApprovalButtons(
  message: EditableApprovalMessage | null | undefined,
  requestedByName: string,
): Promise<void> {
  if (!message) return;
  await message
    .edit({ content: `Changes requested by ${requestedByName}.`, components: [] })
    .catch(() => undefined);
}

/**
 * The modal that collects revision feedback.
 *
 * A modal rather than a follow-up message because Discord will not let a
 * button handler wait for a reply: the interaction has to be answered within
 * three seconds. A modal *is* that answer, and it comes back as its own
 * interaction with a fresh token, which is what buys the minutes a revision
 * takes.
 */
export function buildRevisionModal(prNumber: number, issueNumber: number | null): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(encodeCustomId({ action: "revise", prNumber, issueNumber }))
    .setTitle(`Request changes to PR #${prNumber}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FEEDBACK_INPUT_ID)
          .setLabel("What should change?")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder(
            "e.g. don't poll on a timer, make it a slash command that reports on demand",
          )
          .setRequired(true)
          .setMaxLength(2000),
      ),
    );
}

export function buildAskModal(interactionId: string, aboutAuthor: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(encodeAskCustomId(interactionId))
    .setTitle(`Ask about ${aboutAuthor}'s message`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(QUESTION_INPUT_ID)
          .setLabel("What do you want to know?")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("e.g. what breed is this? — or leave blank and I'll just describe it")
          // Optional: pointing at a photo and saying nothing is a complete
          // request on its own, and the agent is told what to do with it.
          .setRequired(false)
          .setMaxLength(1000),
      ),
    );
}
