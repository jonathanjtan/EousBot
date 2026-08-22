import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { config } from "../config.js";
import type { FeedWatch } from "../feed.js";
import { feedHealth } from "../feedwatch.js";
import { describeListing, streetDateNote } from "../listing.js";
import { readFeedWatches, removeFeedWatch, upsertFeedWatch } from "../state.js";
import { isBuyable, parseTcin, pdpUrl } from "../target.js";
import { probeListing } from "../targetapi.js";
import type { Command } from "./types.js";

/**
 * Drop alerts.
 *
 * `watch` subscribes you to a keyword across the community feeds; `check` reads
 * a specific Target listing right now.
 *
 * The bot does not buy anything, and that is deliberate rather than unfinished:
 * Target's terms prohibit automated purchasing, and evading the bot detection on
 * checkout is what gets an account and a card banned. The part a person actually
 * loses a drop on isn't clicking -- it's finding out forty minutes late.
 *
 * The reason `watch` reads feeds rather than polling Target is measured, not
 * assumed: Target's live stock API answers a bare HTTP client with a CAPTCHA
 * challenge from any network, so there is no stock to poll for. See feed.ts.
 */

/** Ceiling on keyword subscriptions, so the channel stays readable. */
const MAX_WATCHES = 10;

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("restock")
    .setDescription("Get pinged when a Pokémon drop is called")
    .addSubcommand((s) =>
      s
        .setName("watch")
        .setDescription("Ping me when a drop post mentions this word")
        .addStringOption((o) =>
          o
            .setName("keyword")
            .setDescription('e.g. "target", "prismatic", "illustration collection"')
            .setRequired(true)
            .setMinLength(3)
            .setMaxLength(60),
        ),
    )
    .addSubcommand((s) => s.setName("list").setDescription("Show your keyword subscriptions"))
    .addSubcommand((s) =>
      s
        .setName("unwatch")
        .setDescription("Stop watching a keyword")
        .addStringOption((o) =>
          o.setName("keyword").setDescription("The keyword to drop").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("check")
        .setDescription("Read a Target listing right now")
        .addStringOption((o) =>
          o.setName("item").setDescription("Product URL or item number").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName("sources").setDescription("Which feeds are being watched, and are they healthy"),
    ),

  async execute(interaction) {
    if (!config.target.enabled) {
      await interaction.reply({
        content:
          "Drop alerts are off. Set `TARGET_RESTOCK_ENABLED=true` in the bot's environment and restart.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "sources") {
      const health = feedHealth();
      const lines = health.sources.map((s) => `• **${s.name}** — <${s.url}>`);
      const when =
        health.lastPollAt === null
          ? "Not polled yet."
          : `Last polled <t:${Math.floor(health.lastPollAt / 1000)}:R>.`;
      const trouble =
        health.consecutiveBlocks > 0
          ? `\n⚠️ Rate-limited ${health.consecutiveBlocks}× in a row — backing off.`
          : health.lastError
            ? `\n⚠️ ${health.lastError}`
            : "";

      await interaction.reply({
        content: [
          `Watching ${health.sources.length} feed${health.sources.length === 1 ? "" : "s"} every ~${Math.round(config.target.poll.baseMs / 60_000)} min:`,
          ...lines,
          "",
          when + trouble,
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "list") {
      const watches = readFeedWatches();
      if (watches.length === 0) {
        await interaction.reply({
          content: 'Nothing subscribed. Try `/restock watch keyword:target`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const lines = watches.map(
        (w) =>
          `• **${w.keyword}** — ${w.subscribers.length} subscriber${w.subscribers.length === 1 ? "" : "s"}${w.subscribers.includes(interaction.user.id) ? " (including you)" : ""}`,
      );
      await interaction.reply({
        content: `${watches.length}/${MAX_WATCHES} keywords:\n${lines.join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "check") {
      const tcin = parseTcin(interaction.options.getString("item", true));
      if (!tcin) {
        await interaction.reply({
          content:
            "I couldn't find an item number in that. Paste the full `target.com/p/...` URL, or just the number from the `A-` part of it.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(describeProbe(tcin, await probeListing(tcin)));
      return;
    }

    const keyword = interaction.options.getString("keyword", true).trim();

    if (sub === "unwatch") {
      const removed = removeFeedWatch(keyword);
      await interaction.reply({
        content: removed ? `Stopped watching "${keyword}".` : `Wasn't watching "${keyword}".`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // --- watch ---------------------------------------------------------------
    const existing = readFeedWatches();
    const already = existing.find((w) => w.keyword.toLowerCase() === keyword.toLowerCase());

    if (!already && existing.length >= MAX_WATCHES) {
      await interaction.reply({
        content: `Already watching ${MAX_WATCHES} keywords, which is the cap. \`/restock unwatch\` one first.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const watch: FeedWatch = {
      keyword,
      // Re-watching a keyword subscribes you to it rather than replacing whoever
      // set it up: several people wanting the same drop is the normal case.
      subscribers: [...new Set([...(already?.subscribers ?? []), interaction.user.id])],
      channelId: interaction.channelId,
      addedBy: interaction.user.id,
      addedAt: new Date().toISOString(),
    };
    upsertFeedWatch(watch);

    const sources = config.target.feeds.map((s) => s.name).join(", ");
    await interaction.reply({
      content: [
        `Watching **${keyword}** across ${sources}.`,
        `I'll ping you here when a new post matches, checked every ~${Math.round(config.target.poll.baseMs / 60_000)} min.`,
        "",
        "_These are community posts, not a stock check — I can't read Target's live stock (it's behind a CAPTCHA) and I don't buy anything._",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  },
};

function describeProbe(tcin: string, probe: Awaited<ReturnType<typeof probeListing>>): string {
  const { meta, avail, error } = probe;
  const lines = [`**${meta?.title ?? `Item ${tcin}`}**`, `<${pdpUrl(tcin)}>`, ""];

  if (meta && avail) {
    lines.push(...describeListing(meta, avail, Date.now()).map((f) => `• ${f}`));
  } else if (meta) {
    lines.push(`• limit ${meta.purchaseLimit ?? "unknown"} per order`);
    const street = streetDateNote(meta, Date.now());
    if (street) lines.push(`• ${street}`);
  }

  if (meta && !meta.parsedBlob) {
    lines.push("_Product page parsed by fallback — Target changed the page shape._");
  }

  if (avail?.challenged) {
    lines.push("", "**Live stock is behind a CAPTCHA challenge.**");
    lines.push(
      "That's bot detection keyed on the request rather than the network, so it isn't something another host or a longer wait fixes, and getting past it isn't something I'll do. Everything above comes from the product page itself, which still works.",
    );
    lines.push("Target's own *Notify me when it's back* button is the working alternative.");
    return lines.join("\n");
  }

  if (error) {
    lines.push("", `**${error}**`);
    return lines.join("\n");
  }

  if (avail?.blocked) {
    lines.push("", `**Rate limited (HTTP ${avail.status}).** Back off before trying again.`);
    return lines.join("\n");
  }

  if (avail) {
    lines.push("");
    lines.push(`Shipping: ${avail.shipStatus ?? "unknown"}`);
    lines.push(`Pickup: ${avail.pickupStatus ?? "unknown"}`);
    lines.push(`**${isBuyable(avail) ? "In stock" : "Out of stock"}**`);
  }

  return lines.join("\n");
}
