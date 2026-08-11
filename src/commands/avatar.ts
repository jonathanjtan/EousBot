import { EmbedBuilder, GuildMember, SlashCommandBuilder } from "discord.js";
import { avatarViews } from "../avatar.js";
import type { Command } from "./types.js";

/**
 * Shows someone's profile picture. Open to everyone in the guild -- it only
 * repeats an avatar everyone in the channel can already see.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a user's profile picture")
    .addUserOption((o) =>
      o.setName("user").setDescription("Whose avatar to show (default yourself)").setRequired(false),
    ),

  async execute(interaction) {
    const user = interaction.options.getUser("user") ?? interaction.user;

    // getMember returns the raw API object when the guild isn't cached, and that
    // has no displayAvatarURL; fall back to the account avatar in that case.
    const option = interaction.options.getMember("user");
    const self = user.id === interaction.user.id ? interaction.member : null;
    const member = option ?? self;

    const views = avatarViews(user, member instanceof GuildMember ? member : null);
    const [primary] = views;

    const embed = new EmbedBuilder()
      .setColor(member instanceof GuildMember ? member.displayColor || 0x5865f2 : 0x5865f2)
      .setTitle(user.displayName)
      .setURL(primary!.url)
      .setImage(primary!.url)
      .setFooter({ text: primary!.label });

    // Direct links so the picture can be saved without hunting through the
    // embed, and so a second avatar is still reachable when there is one.
    const links = views.map((view) => `[${view.label}](${view.url})`).join(" · ");

    await interaction.reply({ content: links, embeds: [embed] });
  },
};
