import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import { log } from "../log.js";
import {
  SECTION_CHOICES,
  characterFor,
  fetchFrameData,
  frameDataPages,
  matchCharacters,
  pageUrl,
} from "../smash.js";
import type { Command } from "./types.js";

/** Ultimate Frame Data's own yellow, so the embed looks like where it came from. */
const COLOUR = 0xffc640;

/**
 * Frame data for a fighter in Smash Ultimate, read off Ultimate Frame Data.
 *
 * A whole character is more than one embed holds, so the reply is the first
 * page and the rest follow it in the channel. Open to everyone in the guild --
 * it reads a public page and takes no action on anyone's behalf.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("smash")
    .setDescription("Super Smash Bros. Ultimate reference")
    .addSubcommand((sub) =>
      sub
        .setName("framedata")
        .setDescription("Show a fighter's frame data")
        .addStringOption((o) =>
          o
            .setName("character")
            .setDescription("Which fighter")
            .setRequired(true)
            .setAutocomplete(true)
            .setMaxLength(40),
        )
        .addStringOption((o) =>
          o
            .setName("section")
            .setDescription("Only one part of the table (default all of it)")
            .addChoices(...SECTION_CHOICES.map(({ id, label }) => ({ name: label, value: id })))
            .setRequired(false),
        ),
    ),

  // Eighty-eight fighters is far past the twenty-five choices an option may
  // carry, so the roster is offered as you type instead.
  async autocomplete(interaction) {
    const query = interaction.options.getFocused();
    await interaction.respond(
      matchCharacters(query).map((character) => ({ name: character.name, value: character.slug })),
    );
  },

  async execute(interaction) {
    const raw = interaction.options.getString("character", true);
    const section = interaction.options.getString("section");

    const character = characterFor(raw);
    if (character === null) {
      // Their own typo, so keep it out of everyone else's channel.
      await interaction.reply({
        content: `No fighter goes by \`${raw.slice(0, 40)}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // A round trip to Ultimate Frame Data, so the three seconds Discord allows
    // for a reply are not enough.
    await interaction.deferReply();

    let data;
    try {
      data = await fetchFrameData(character);
    } catch (err) {
      log.warn("Could not read Ultimate Frame Data", { character: character.slug, err });
      await interaction.editReply("Couldn't reach Ultimate Frame Data just now.");
      return;
    }

    const pages = frameDataPages(data, section);
    if (pages.length === 0) {
      // Either the page changed shape under us or the section is one this
      // fighter has nothing in; the site itself is the answer either way.
      await interaction.editReply(
        `No frame data came back for ${character.name}. The page is at ${pageUrl(character)}`,
      );
      return;
    }

    const label = SECTION_CHOICES.find((choice) => choice.id === section)?.label;
    const embeds = pages.map((page, index) =>
      new EmbedBuilder()
        .setColor(COLOUR)
        .setTitle(
          index === 0
            ? `${character.name}: ${label ?? "Frame Data"}`
            : `${character.name} (cont.)`,
        )
        .setURL(pageUrl(character))
        .setDescription(page)
        .setFooter({
          text:
            pages.length > 1
              ? `Ultimate Frame Data · ${index + 1}/${pages.length}`
              : "Ultimate Frame Data",
        }),
    );

    await interaction.editReply({ embeds: [embeds[0]!] });
    // Discord caps the embeds one message may carry, and these are near the
    // per-embed ceiling already, so the rest go out as their own messages.
    for (const embed of embeds.slice(1)) {
      await interaction.followUp({ embeds: [embed] });
    }
  },
};
