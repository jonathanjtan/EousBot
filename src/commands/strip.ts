import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { StripError, stripUrl } from "../strip.js";
import type { Command } from "./types.js";

/**
 * Cleans tracking parameters off a link. Open to everyone -- it only rewrites
 * text the caller supplied.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("strip")
    .setDescription("Remove tracking parameters from a URL")
    .addStringOption((o) =>
      o.setName("url").setDescription("The link to clean up").setRequired(true),
    )
    .addBooleanOption((o) =>
      o
        .setName("all")
        .setDescription("Drop every query parameter, not just known trackers")
        .setRequired(false),
    ),

  async execute(interaction) {
    const input = interaction.options.getString("url", true);
    const all = interaction.options.getBoolean("all") ?? false;

    let result;
    try {
      result = stripUrl(input, all);
    } catch (error) {
      if (!(error instanceof StripError)) throw error;
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }

    if (result.removed.length === 0) {
      await interaction.reply({ content: `Nothing to strip.\n${result.url}` });
      return;
    }

    // The parameter names go in the reply so the caller can see what was
    // dropped and re-add anything the list got wrong.
    const names = result.removed.map((name) => `\`${name}\``).join(", ");
    await interaction.reply({ content: `${result.url}\n-# removed ${names}` });
  },
};
