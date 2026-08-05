import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { buildRevisionModal } from "../approval.js";
import { getPullRequest } from "../github.js";
import { cachedRevisionRefusal } from "../usagegate.js";
import type { Command } from "./types.js";

/**
 * Requests changes to an open pull request, without needing its approval
 * embed.
 *
 * The Request changes button only exists on messages posted by a build that
 * knew about it, and Discord will not retroactively add a component to a
 * message already sent. That leaves any PR opened before the feature shipped
 * reachable only by approving or rejecting it. More generally, an embed
 * scrolls away, and a channel purge should not be able to strand a PR.
 *
 * This is the same modal and the same pipeline -- only the entry point differs.
 *
 * Open to everyone, on the same usage gate the button carries: see
 * src/usagegate.ts.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("revise")
    .setDescription("Ask the agent to change an open pull request")
    .addIntegerOption((o) =>
      o.setName("pr").setDescription("The pull request number").setRequired(true),
    ),

  async execute(interaction) {
    const prNumber = interaction.options.getInteger("pr", true);

    // Check before opening the modal: discovering the PR is closed after
    // someone has typed a paragraph of feedback wastes the paragraph.
    let pr;
    try {
      pr = await getPullRequest(prNumber);
    } catch {
      await interaction.reply({
        content: `No pull request numbered **#${prNumber}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (pr.state !== "open") {
      await interaction.reply({
        content: `PR **#${prNumber}** is ${pr.state}, so there is nothing to revise.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Same courtesy for the usage gate: refuse now if the last usage reading
    // already says there's no room. The binding check runs on submit.
    const refusal = cachedRevisionRefusal(interaction.user.id);
    if (refusal) {
      await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
      return;
    }

    // issueNumber is left null: revisePullRequest recovers it from the PR body,
    // which is the same path a button-initiated revision takes.
    await interaction.showModal(buildRevisionModal(prNumber, null));
  },
};
