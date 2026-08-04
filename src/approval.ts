import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

/**
 * The approval prompt: a PR summary plus the two buttons that decide its fate.
 *
 * All the context the button handler needs is encoded in the custom ID, so an
 * approval posted before a restart still works after one. Discord caps custom
 * IDs at 100 characters, which two integers and a prefix stay well within.
 */

const PREFIX = "eous";

export type ApprovalAction = "approve" | "reject";

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
  if (action !== "approve" && action !== "reject") return null;

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
        encodeCustomId({ action: "reject", prNumber: opts.prNumber, issueNumber: opts.issueNumber }),
      )
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}
