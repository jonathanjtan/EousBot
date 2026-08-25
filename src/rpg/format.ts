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
    .setTitle(`${character.name} — ${className(character)}`)
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
  return `**${item.name}** — ${item.value} ${item.kind === "weapon" ? "damage" : "protection"}${mark}`;
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
    "`  # │ time  │ odds │ coin    │ xp     │ expected`",
    "`────┼───────┼──────┼─────────┼────────┼─────────`",
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
        `${shortDuration(expeditionDuration(d, t)).padStart(5)} │ ` +
        `${`${Math.round(odds * 100)}%`.padStart(4)} │ ` +
        `${String(money).padStart(7)} │ ` +
        `${String(xp).padStart(6)} │ ` +
        `${String(evPerHour).padStart(6)}/h` +
        "`",
    );
  }

  return [
    `**Where to, ${character.name}?**`,
    ...rows,
    "",
    `\`/idlerpg adventure difficulty:<n>\` — you unlock harder ones by levelling.`,
  ].join("\n");
}

export function claimMessage(character: Character, reward: ClaimReward): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(reward.won ? `Difficulty ${reward.difficulty} — success` : `Difficulty ${reward.difficulty} — failed`)
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
    .map((i) => `\`#${String(i.id).padEnd(4)}\` ${describe(i)} — sells for ${coin(sellValue(i))}`);

  return [
    `**${character.name}**'s backpack (${character.backpack.length}/${t.backpackSize})`,
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
    "**The realm**",
    ...characters.map(
      (c, i) =>
        `\`${String(i + 1).padStart(2)}\` **${c.name}** — level ${c.level} ${className(c)}, ` +
        `${coin(c.money)}, power ${attack(c) + defense(c)}`,
    ),
  ].join("\n");
}

export function classMenu(): string {
  return [
    "**Pick a class.** Each does exactly one thing, and it gets stronger as you level.",
    "",
    ...Object.values(CLASSES).map((c) => `**${c.id}** — ${c.summary}`),
  ].join("\n");
}
