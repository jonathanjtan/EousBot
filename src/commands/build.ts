import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { buildApprovalMessage } from "../approval.js";
import { getFeatureRequest } from "../github.js";
import { log } from "../log.js";
import { buildFeature } from "../pipeline.js";
import type { Command } from "./types.js";

/**
 * Only one build runs at a time.
 *
 * Builds share the deploy checkout's git directory for worktree bookkeeping,
 * and each one runs an `npm install`. Two at once would race over both. Serial
 * is also plenty: builds take minutes and arrive at human pace.
 */
let inFlight: { issueNumber: number; startedBy: string } | null = null;

export const command: Command = {
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName("build")
    .setDescription("Have the bot write code for a feature request (admin only)")
    .addIntegerOption((o) =>
      o
        .setName("id")
        .setDescription("The feature request number, from /status")
        .setRequired(true),
    ),

  async execute(interaction) {
    const issueNumber = interaction.options.getInteger("id", true);

    if (inFlight) {
      await interaction.reply({
        content: `Already building **#${inFlight.issueNumber}** (started by ${inFlight.startedBy}). Builds run one at a time — try again when it finishes.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const request = await getFeatureRequest(issueNumber);
    if (!request) {
      await interaction.reply({
        content: `No feature request numbered **#${issueNumber}**. Check \`/status\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    inFlight = { issueNumber, startedBy: interaction.user.username };
    await interaction.deferReply();

    // Progress arrives faster than Discord's edit rate limit tolerates, so
    // coalesce: keep the latest stage and flush on a timer.
    let latest = "Starting…";
    let dirty = false;
    const flush = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      interaction
        .editReply(`**Building #${issueNumber}** — ${request.title}\n\`${latest}\``)
        .catch(() => undefined);
    }, 4000);

    try {
      const outcome = await buildFeature(request, (stage, detail) => {
        latest = detail ? `${stage}: ${detail.replace(/\s+/g, " ").slice(0, 120)}` : stage;
        dirty = true;
      });

      clearInterval(flush);

      switch (outcome.kind) {
        case "opened": {
          await interaction.editReply(
            `**#${issueNumber}** built successfully — review below.`,
          );
          await interaction.followUp(
            buildApprovalMessage({
              prNumber: outcome.prNumber,
              prUrl: outcome.prUrl,
              issueNumber,
              title: request.title,
              summary: outcome.summary,
              diffStat: outcome.diffStat,
              costUsd: outcome.costUsd,
              requestedBy: request.requestedBy,
            }),
          );
          break;
        }
        case "no-changes":
          await interaction.editReply(
            `**#${issueNumber}**: the agent finished but changed nothing. Its notes are on the issue.`,
          );
          break;
        case "failed":
          await interaction.editReply(
            [
              `**#${issueNumber}** failed at \`${outcome.stage}\`. No pull request was opened.`,
              "```",
              outcome.detail.slice(0, 1500),
              "```",
            ].join("\n"),
          );
          break;
      }
    } catch (err) {
      clearInterval(flush);
      log.error("Build threw", { issue: issueNumber, err: String(err) });
      await interaction
        .editReply(`**#${issueNumber}** crashed the build pipeline:\n\`\`\`\n${String(err).slice(0, 1500)}\n\`\`\``)
        .catch(() => undefined);
    } finally {
      clearInterval(flush);
      inFlight = null;
    }
  },
};
