import { EmbedBuilder } from "discord.js";
import { CLASSES, RARITY_COLOUR } from "./content.js";
import {
  DEFAULT_TUNING,
  attack,
  className,
  coin,
  defense,
  expeditionDuration,
  maxDifficultyFor,
  moneyReward,
  sellValue,
  shortDuration,
  successChance,
  xpReward,
  xpToLevel,
} from "./rules.js";
import type { ClaimReward } from "./engine.js";
import { RARITIES, type Character, type Item, type Tuning } from "./types.js";

/**
 * Rendering a character and its options.
 *
 * The adventure table is the important one. This game's whole claim over the
 * IRC original is that the player makes a decision, and a decision needs its
 * terms visible: what each option costs in time, what it pays, and how likely
 * it is to pay at all. Hiding the odds would make it a slot machine.
 */

export function profile(character: Character, t: Tuning = DEFAULT_TUNING): EmbedBuilder {
  const need = xpToLevel(character.level);
  const bar = progressBar(character.xp, need);
  const crates = RARITIES.filter((r) => character.crates[r] > 0)
    .map((r) => `${r} ×${character.crates[r]}`)
    .join(", ");

  const embed = new EmbedBuilder()
    .setTitle(`${character.name}, ${className(character)}`)
    .setColor(0x2f81f7)
    .addFields(
      { name: "Level", value: `${character.level}`, inline: true },
      { name: "Coin", value: coin(character.money), inline: true },
      { name: "Class", value: CLASSES[character.classId].id, inline: true },
      { name: "Attack", value: `${attack(character)}`, inline: true },
      { name: "Defense", value: `${defense(character)}`, inline: true },
      { name: "Power", value: `${attack(character) + defense(character)}`, inline: true },
      { name: `Experience (${character.xp}/${need})`, value: bar },
      {
        name: "Carrying",
        value: [
          `⚔️ ${character.weapon ? describe(character.weapon) : "nothing"}`,
          `🛡️ ${character.armor ? describe(character.armor) : "nothing"}`,
        ].join("\n"),
      },
    );

  if (crates) embed.addFields({ name: "Crates", value: crates });

  const { won, lost, duelsWon, duelsLost } = character.stats;
  embed.setFooter({
    text:
      `${won}W/${lost}L on adventures · ${duelsWon}W/${duelsLost}L in duels · ` +
      `backpack ${character.backpack.length}/${t.backpackSize}`,
  });
  return embed;
}

function progressBar(have: number, need: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((have / Math.max(1, need)) * width)));
  return `\`${"█".repeat(filled)}${"░".repeat(width - filled)}\` ${Math.floor((have / Math.max(1, need)) * 100)}%`;
}

export function describe(item: Item): string {
  const mark = item.rarity === "common" ? "" : ` *(${item.rarity})*`;
  return `**${item.name}**, ${item.value} ${item.kind === "weapon" ? "damage" : "protection"}${mark}`;
}

/**
 * The menu of adventures, with their real terms.
 *
 * Every row a player can legally take, so the choice is a comparison rather
 * than a guess. Expected value is shown alongside the raw reward because the
 * interesting decision -- reach high and often fail, or stay safe and grind --
 * is invisible without it.
 */
export function adventureTable(character: Character, t: Tuning = DEFAULT_TUNING): string {
  const ceiling = maxDifficultyFor(character, t);
  const rows: string[] = [
    "`  # │  time   │ odds │ coin    │ xp     │ expected`",
    "`────┼─────────┼──────┼─────────┼────────┼─────────`",
  ];

  for (let d = 1; d <= ceiling; d += 1) {
    const odds = successChance(character, d, t);
    const money = moneyReward(character, d, t);
    const xp = xpReward(character, d, t);
    const hours = expeditionDuration(d, t) / 3_600_000;
    const evPerHour = Math.round((odds * money) / Math.max(0.01, hours));
    rows.push(
      "`" +
        `${String(d).padStart(3)} │ ` +
        `${shortDuration(expeditionDuration(d, t)).padStart(7)} │ ` +
        `${`${Math.round(odds * 100)}%`.padStart(4)} │ ` +
        `${String(money).padStart(7)} │ ` +
        `${String(xp).padStart(6)} │ ` +
        `${String(evPerHour).padStart(6)}/h` +
        "`",
    );
  }

  return [
    `Where to, ${character.name}?`,
    ...rows,
    "",
    `\`/idlerpg adventure difficulty:<n>\`. Harder ones unlock as you level.`,
  ].join("\n");
}

export function claimMessage(character: Character, reward: ClaimReward): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(reward.won ? `Difficulty ${reward.difficulty}, success` : `Difficulty ${reward.difficulty}, failed`)
    .setDescription(`Your party ${reward.line}.`)
    .setColor(reward.won ? 0x4caf50 : 0xcf4a4a);

  if (!reward.won) {
    embed.setFooter({ text: "Nothing gained but the time. Try lower, or come back better armed." });
    return embed;
  }

  const lines = [`**+${coin(reward.money)}**`, `**+${reward.xp}** experience`];
  if (reward.stolen > 0) lines.push(`**+${coin(reward.stolen)}** lifted on the way out`);
  if (reward.crate) lines.push(`a **${reward.crate}** crate`);
  embed.addFields({ name: "Brought back", value: lines.join("\n") });

  if (reward.levelsGained > 0) {
    embed.addFields({
      name: "Level up",
      value:
        `Now level ${character.level}.` +
        (reward.newTier ? ` You are a **${reward.newTier}**.` : ""),
    });
  }
  return embed;
}

export function backpack(character: Character, t: Tuning = DEFAULT_TUNING): string {
  if (character.backpack.length === 0) {
    return `**${character.name}**'s backpack is empty.`;
  }
  const rows = character.backpack
    .slice()
    .sort((a, b) => b.value - a.value)
    .map((i) => `\`#${String(i.id).padEnd(4)}\` ${describe(i)}, sells for ${coin(sellValue(i))}`);

  return [
    `${character.name}'s backpack (${character.backpack.length}/${t.backpackSize})`,
    ...rows.slice(0, 25),
    ...(rows.length > 25 ? [`_…and ${rows.length - 25} more._`] : []),
  ].join("\n");
}

export function crateColour(rarity: keyof typeof RARITY_COLOUR): number {
  return RARITY_COLOUR[rarity];
}

export function ranking(characters: Character[]): string {
  if (characters.length === 0) {
    return "Nobody has a character yet. `/idlerpg start` makes one.";
  }
  return [
    "The realm:",
    ...characters.map(
      (c, i) =>
        `\`${String(i + 1).padStart(2)}\` **${c.name}**, level ${c.level} ${className(c)}, ` +
        `${coin(c.money)}, power ${attack(c) + defense(c)}`,
    ),
  ].join("\n");
}

export function classMenu(): string {
  return [
    "Pick a class. Each does one thing, and it gets stronger as you level.",
    "",
    ...Object.values(CLASSES).map((c) => `**${c.id}**, ${c.summary}`),
  ].join("\n");
}

// ------------------------------------------- guilds, market, raids, gods ---

import { GODS, RACES, RACE_IDS } from "./content.js";
import { CRATE_PRICE, favorLuck, guildCapacity, guildUpgradeCost, loveBonus, power } from "./rules.js";
import type { Guild, Listing, Raid, Tournament } from "./types.js";

export function raceMenu(): string {
  return [
    "Pick a race. Smaller than your class choice, and permanent.",
    "",
    ...RACE_IDS.map((id) => `**${id}**, ${RACES[id].summary}`),
  ].join("\n");
}

export function godMenu(): string {
  return [
    "Following a god lets you sacrifice items you cannot wear,",
    "and favour buys better odds on every adventure.",
    "",
    ...Object.values(GODS).map((g) => `**${g.id}**, ${g.title}. ${g.summary}`),
  ].join("\n");
}

export function godStanding(character: Character): string {
  if (!character.god) {
    return "You follow no god. `/idlerpg god follow` picks one, and `/idlerpg god sacrifice` feeds it.";
  }
  const god = GODS[character.god];
  const luck = favorLuck(character);
  return [
    `**${character.name}** follows ${god.title}.`,
    `Favour: **${character.favor.toLocaleString("en-US")}**`,
    `Worth **+${(luck * 100).toFixed(1)} points** of adventure odds.`,
  ].join("\n");
}

export function storeList(): string {
  return [
    "The shop sells crates only. They cost more than their contents sell for,",
    "so buy them for gear you can wear, not to resell.",
    "",
    ...RARITIES.map((r) => `**${r}**, ${coin(CRATE_PRICE[r])}`),
    "",
    "`/idlerpg store buy rarity:<r> count:<n>`",
  ].join("\n");
}

export function guildCard(guild: Guild, roster: Character[], allies: Guild[]): EmbedBuilder {
  const byPower = [...roster].sort((a, b) => power(b) - power(a));
  const embed = new EmbedBuilder()
    .setTitle(`${guild.name}, level ${guild.level}`)
    .setColor(0xa970ff)
    .addFields(
      { name: "Bank", value: coin(guild.bank), inline: true },
      {
        name: "Members",
        value: `${guild.memberIds.length}/${guildCapacity(guild.level)}`,
        inline: true,
      },
      {
        name: "Total power",
        value: `${roster.reduce((sum, c) => sum + power(c), 0)}`,
        inline: true,
      },
    );

  if (byPower.length > 0) {
    embed.addFields({
      name: "Roster",
      value: byPower
        .slice(0, 20)
        .map((c) => {
          const rank =
            c.userId === guild.leaderId ? "👑" : guild.officerIds.includes(c.userId) ? "🔹" : "▫️";
          return `${rank} **${c.name}**, level ${c.level}, power ${power(c)}`;
        })
        .join("\n"),
    });
  }

  const others = allies.filter((g) => g.id !== guild.id);
  if (others.length > 0) {
    embed.addFields({ name: "Alliance", value: others.map((g) => g.name).join(", ") });
  }
  embed.setFooter({ text: `Next upgrade: ${coin(guildUpgradeCost(guild.level))} from the bank.` });
  return embed;
}

export function guildList(guilds: Guild[]): string {
  if (guilds.length === 0) return "No guilds yet. `/idlerpg guild create` founds one.";
  return [
    "Guilds:",
    ...guilds
      .sort((a, b) => b.memberIds.length - a.memberIds.length)
      .slice(0, 20)
      .map((g) => `**${g.name}**, level ${g.level}, ${g.memberIds.length} members, ${coin(g.bank)}`),
  ].join("\n");
}

export function marketBoard(listings: Listing[], nameOf: (id: string) => string): string {
  if (listings.length === 0) {
    return "The market is empty. `/idlerpg market sell` lists something.";
  }
  return [
    "The market, cheapest first.",
    ...listings.map(
      (l) => `\`#${String(l.id).padEnd(4)}\` ${describe(l.item)}, **${coin(l.price)}** from ${nameOf(l.sellerId)}`,
    ),
    "",
    "`/idlerpg market buy listing:<n>`",
  ].join("\n");
}

export function raidCard(raid: Raid, nameOf: (id: string) => string): EmbedBuilder {
  const width = 24;
  const filled = Math.max(0, Math.min(width, Math.round((raid.hp / raid.maxHp) * width)));
  const top = Object.entries(raid.damage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, dealt], i) => `\`${String(i + 1).padStart(2)}\` ${nameOf(id)}, ${dealt.toLocaleString("en-US")}`);

  return new EmbedBuilder()
    .setTitle(raid.bossName)
    .setColor(0xcf4a4a)
    .setDescription(
      [
        `\`${"█".repeat(filled)}${"░".repeat(width - filled)}\``,
        `**${raid.hp.toLocaleString("en-US")}** / ${raid.maxHp.toLocaleString("en-US")} left`,
        `Pot: **${coin(raid.pot)}**, split by damage dealt.`,
        `Escapes <t:${Math.floor(raid.endsAt / 1000)}:R>.`,
      ].join("\n"),
    )
    .addFields(top.length > 0 ? [{ name: "Damage", value: top.join("\n") }] : []);
}

export function tournamentCard(t: Tournament, nameOf: (id: string) => string): string {
  if (t.finished) {
    return [
      `**Tournament over.** ${t.winnerId ? `**${nameOf(t.winnerId)}** takes ${coin(t.buyIn * t.entries.length)}.` : "Nobody won."}`,
      "",
      ...t.log,
    ].join("\n");
  }
  return [
    `Tournament. Buy-in ${coin(t.buyIn)}, pot ${coin(t.buyIn * t.entries.length)}.`,
    `Entries close <t:${Math.floor(t.closesAt / 1000)}:R>.`,
    "",
    `**${t.entries.length} entered:** ${t.entries.map((e) => nameOf(e.userId)).join(", ")}`,
    "",
    "`/idlerpg tournament join` · `/idlerpg tournament run`",
  ].join("\n");
}

export function marriageCard(character: Character, spouse: Character | null): string {
  if (!spouse) return "You are not married. `/idlerpg marry propose` starts something.";
  return [
    `**${character.name}** and **${spouse.name}**.`,
    `Affection: **${character.loveScore.toLocaleString("en-US")}**`,
    `Worth **+${loveBonus(character).toFixed(1)}%** to both of you.`,
    "",
    "`/idlerpg marry court` spends coin to raise it.",
  ].join("\n");
}

// ------------------------------------------------------------------ ranks ---

/** What a leaderboard can be sorted by. */
export type RankMetric = "level" | "money" | "power" | "adventures" | "duels" | "favor";

export const RANK_METRICS: readonly RankMetric[] = [
  "level",
  "money",
  "power",
  "adventures",
  "duels",
  "favor",
];

const RANK_LABEL: Record<RankMetric, string> = {
  level: "Level",
  money: "Coin",
  power: "Power",
  adventures: "Adventures won",
  duels: "Duels won",
  favor: "Favour",
};

function rankValue(character: Character, metric: RankMetric): number {
  switch (metric) {
    case "level":
      return character.level;
    case "money":
      return character.money;
    case "power":
      return power(character);
    case "adventures":
      return character.stats.won;
    case "duels":
      return character.stats.duelsWon;
    case "favor":
      return character.favor;
  }
}

function rankDisplay(character: Character, metric: RankMetric): string {
  if (metric === "money") return coin(character.money);
  return rankValue(character, metric).toLocaleString("en-US");
}

/**
 * A leaderboard by any metric.
 *
 * More than one board exists because a single one tells everybody who plays
 * differently that they are losing. Level rewards steady play, coin rewards
 * trading, power rewards gear luck, and favour rewards giving things up -- and
 * a realm where four people each top a different board is a healthier one.
 */
export function rankBoard(
  characters: Character[],
  metric: RankMetric,
  limit: number,
): string {
  const ranked = [...characters]
    .sort((a, b) => rankValue(b, metric) - rankValue(a, metric))
    .slice(0, limit);

  if (ranked.length === 0) {
    return "Nobody has a character yet. `/idlerpg start` makes one.";
  }
  return [
    `${RANK_LABEL[metric]}:`,
    ...ranked.map(
      (c, i) => `\`${String(i + 1).padStart(2)}\` **${c.name}**, ${rankDisplay(c, metric)}`,
    ),
  ].join("\n");
}
