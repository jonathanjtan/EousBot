import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { EmbedError, fixEmbedUrl } from "../embed.js";
import { StripError, stripUrl } from "../strip.js";
import type { Command } from "./types.js";

/**
 * Rewrites a social media link onto a service that renders a working preview.
 * Open to everyone -- it only rewrites text the caller supplied.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("embed")
    .setDescription("Rewrite a social media link so it previews properly in Discord")
    .addStringOption((o) =>
      o.setName("url").setDescription("The post to fix").setRequired(true),
    ),

  async execute(interaction) {
    const input = interaction.options.getString("url", true);

    // Share links come off the mobile apps carrying tracking parameters, so
    // they get the same cleaning /strip does first -- its host rules key off
    // the original host, which is why that has to happen before the swap.
    let cleaned;
    let result;
    try {
      cleaned = stripUrl(input);
      result = fixEmbedUrl(cleaned.url);
    } catch (error) {
      if (!(error instanceof StripError) && !(error instanceof EmbedError)) throw error;
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }

    // The footnote names the service so a caller who gets a broken preview can
    // tell whether the link was wrong or the fixer is having a bad day.
    const notes = [`${result.platform} via ${result.host}`];
    if (cleaned.removed.length > 0) {
      notes.push(`removed ${cleaned.removed.map((name) => `\`${name}\``).join(", ")}`);
    }

    await interaction.reply({ content: `${result.url}\n-# ${notes.join(" · ")}` });
  },
};
