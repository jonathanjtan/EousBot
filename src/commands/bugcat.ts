import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { pickSticker, stickerUrl } from "../bugcat.js";
import type { Command } from "./types.js";

/** Posts a random Bugcat Capoo sticker. Open to everyone in the guild. */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("bugcat")
    .setDescription("Post a random Bugcat Capoo sticker"),

  async execute(interaction) {
    // An embed rather than a bare link: the image renders even when Discord
    // declines to unfurl, and it leaves somewhere to credit the artist.
    const embed = new EmbedBuilder()
      .setColor(0x6ec6f1)
      .setImage(stickerUrl(pickSticker()))
      .setFooter({ text: "Bugcat Capoo by Yara" });

    await interaction.reply({ embeds: [embed] });
  },
};
