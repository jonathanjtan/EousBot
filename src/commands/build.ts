import { MessageFlags, SlashCommandBuilder } from "discord.js";
import {
  EFFORT_CHOICES,
  MODEL_CHOICES,
  parseEffort,
  parseModel,
} from "../agentopts.js";
import { buildApprovalMessage } from "../approval.js";
import { getFeatureRequest } from "../github.js";
import { log } from "../log.js";
import { buildFeature } from "../pipeline.js";
import type { AgentOptions } from "../agentopts.js";
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

    // Overrides are worth showing while it runs: they change what the build
    // costs and how long it takes, and the requester picked them a screen ago.
    const overrides = [agentOptions.model, agentOptions.effort].filter(Boolean).join(", ");
    const header =
      `**Building #${issueNumber}** — ${request.title}` + (overrides ? ` (${overrides})` : "");

    // Progress arrives faster than Discord's edit rate limit tolerates, so
    // coalesce: keep the latest stage and flush on a timer.
    let latest = "Starting…";
    let dirty = false;
    const flush = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      interaction.editReply(`${header}\n\`${latest}\``).catch(() => undefined);
    }, 4000);

    try {
      const outcome = await buildFeature(
        request,
        (stage, detail) => {
          latest = detail ? `${stage}: ${detail.replace(/\s+/g, " ").slice(0, 120)}` : stage;
          dirty = true;
        },
        agentOptions,
      );

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
