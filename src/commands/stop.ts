import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { describe, held } from "../inflight.js";
import { isChatRunning, isRunning, stopRunning } from "../running.js";
import type { Command } from "./types.js";

/**
 * Stops the agent run in flight.
 *
 * docs/usage.md identifies "nothing stops a run early" as a cost driver of its
 * own: every remaining turn re-reads the entire accumulated context, so a run
 * that is visibly going nowhere gets more expensive the longer nobody stops
 * it. Interactive sessions are interrupted constantly, and every interruption
 * is turns not taken. This is that, from Discord.
 *
 * Stopping is safe by construction: nothing is pushed until the gates pass, so
 * an interrupted run leaves the PR exactly as it was and costs only what it
 * had already spent.
 */
export const command: Command = {
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Interrupt the agent run in progress (admin only)"),

  async execute(interaction) {
    const claim = held();

    if (!isRunning() && !isChatRunning()) {
      await interaction.reply({
        content: claim
          ? `${describe(claim)} is in a stage that isn't the agent: installing, running gates, or pushing. Those finish on their own shortly.`
          : "Nothing is running.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const stopped = await stopRunning();

    await interaction.editReply(
      stopped
        ? [
            claim ? `Stopped ${describe(claim)}.` : "Stopped the agent.",
            "Nothing was pushed, so nothing is half-finished. The tokens it had already spent are spent, and the rest are not.",
          ].join("\n")
        : "Tried to interrupt it, but the agent didn't acknowledge. It may have finished on its own, so check the build message.",
    );
  },
};
