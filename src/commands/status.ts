import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { LABELS, getFeatureRequest, listFeatureRequests } from "../github.js";
import { log } from "../log.js";
import type { Command } from "./types.js";

const STATUS_DISPLAY: Record<string, string> = {
  [LABELS.building]: "🔨 building",
  [LABELS.needsReview]: "👀 awaiting review",
  [LABELS.failed]: "❌ build failed",
  [LABELS.shipped]: "✅ shipped",
};

const describe = (status: string | null): string =>
  status ? (STATUS_DISPLAY[status] ?? status) : "📥 queued";

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show feature requests and where they stand")
    .addIntegerOption((o) =>
      o.setName("id").setDescription("A specific request number").setRequired(false),
    )
    .addBooleanOption((o) =>
      o.setName("all").setDescription("Include closed requests").setRequired(false),
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const id = interaction.options.getInteger("id");
    const includeClosed = interaction.options.getBoolean("all") ?? false;

    try {
      if (id !== null) {
        const req = await getFeatureRequest(id);
        if (!req) {
          await interaction.editReply(`No feature request numbered **#${id}**.`);
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(req.state === "closed" ? 0x5319e7 : 0x1d76db)
          .setTitle(`#${req.number} — ${req.title}`)
          .setURL(req.url)
          .setDescription(req.body.slice(0, 1000) || "_no description_")
          .addFields(
            { name: "Status", value: describe(req.status), inline: true },
            { name: "State", value: req.state, inline: true },
            {
              name: "Requested by",
              value: req.requestedBy ? `<@${req.requestedBy}>` : "unknown",
              inline: true,
            },
          );

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      const requests = await listFeatureRequests(includeClosed);
      if (requests.length === 0) {
        await interaction.editReply(
          "No feature requests yet. Use `/request` to file the first one.",
        );
        return;
      }

      // Discord caps embed descriptions at 4096 chars; 25 requests of one line
      // each stays comfortably inside that.
      const lines = requests.map(
        (r) => `\`#${r.number}\` ${describe(r.status)} — [${r.title}](${r.url})`,
      );

      const embed = new EmbedBuilder()
        .setColor(0x1d76db)
        .setTitle(`Feature requests (${requests.length})`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: "/status <id> for detail · /build <id> to start one" });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      log.error("Failed to read status", { err: String(err) });
      await interaction.editReply("Couldn't reach GitHub to read request status.");
    }
  },
};
