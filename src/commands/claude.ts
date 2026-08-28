import { MessageFlags, SlashCommandBuilder } from "discord.js";
import {
  EFFORT_CHOICES,
  MODEL_CHOICES,
  parseEffort,
  parseModel,
} from "../agentopts.js";
import { buildApprovalMessage } from "../approval.js";
import { acquire, describe, release } from "../inflight.js";
import { getFeatureRequest } from "../github.js";
import { log } from "../log.js";
import { buildFeature } from "../pipeline.js";
import { startProgress } from "../progress.js";
import type { AgentOptions } from "../agentopts.js";
import type { Command } from "./types.js";

// The lock is shared with revisions (see src/inflight.ts): all three entry
// points drive the same worktree bookkeeping in the same checkout.

export const command: Command = {
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName("claude")
    .setDescription("Have the bot write code for a feature request (admin only)")
    .addIntegerOption((o) =>
      o
        .setName("id")
        .setDescription("The feature request number, from /status")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("model")
        .setDescription("Model that writes the code (default: the bot's configured model)")
        .addChoices(...MODEL_CHOICES),
    )
    .addStringOption((o) =>
      o
        .setName("effort")
        .setDescription("How hard it thinks (default: the bot's configured level)")
        .addChoices(...EFFORT_CHOICES),
    ),

  async execute(interaction) {
    const issueNumber = interaction.options.getInteger("id", true);
    // Discord already rejects anything outside the choice lists; parsing again
    // keeps the types honest and survives a stale command schema.
    const agentOptions: AgentOptions = {
      model: parseModel(interaction.options.getString("model")),
      effort: parseEffort(interaction.options.getString("effort")),
    };

    const existing = acquire({
      kind: "build",
      target: issueNumber,
      startedBy: interaction.user.username,
      channelId: interaction.channelId,
      at: new Date().toISOString(),
    });
    if (!existing.ok) {
      await interaction.reply({
        content: `${describe(existing.held)} is already running. These go one at a time, so try again when it finishes.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const request = await getFeatureRequest(issueNumber);
    if (!request) {
      release();
      await interaction.reply({
        content: `No feature request numbered **#${issueNumber}**. Check \`/status\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    // Overrides are worth showing while it runs: they change what the build
    // costs and how long it takes, and the requester picked them a screen ago.
    const overrides = [agentOptions.model, agentOptions.effort].filter(Boolean).join(", ");
    const header =
      `**Building #${issueNumber}**: ${request.title}` + (overrides ? ` (${overrides})` : "");

    const progress = await startProgress(interaction, header);
    progress.update("Starting…");

    try {
      const outcome = await buildFeature(
        request,
        (stage, detail) => {
          progress.update(
            detail ? `${stage}: ${detail.replace(/\s+/g, " ").slice(0, 120)}` : stage,
          );
        },
        agentOptions,
      );

      switch (outcome.kind) {
        case "opened": {
          await progress.finish(`**#${issueNumber}** built successfully. Review below.`);
          await progress.followUp(
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
          await progress.finish(
            `**#${issueNumber}**: the agent finished but changed nothing. Its notes are on the issue.`,
          );
          break;
        case "failed":
          await progress.finish(
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
      log.error("Build threw", { issue: issueNumber, err: String(err) });
      await progress.finish(
        `**#${issueNumber}** crashed the build pipeline:\n\`\`\`\n${String(err).slice(0, 1500)}\n\`\`\``,
      );
    } finally {
      progress.stop();
      release();
    }
  },
};
