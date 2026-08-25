import { EmbedBuilder } from "discord.js";
import { DEFAULT_TUNING, duration, itemSum, timeToLevel } from "./rules.js";
import {
  ITEM_SLOTS,
  SLOT_NAMES,
  type GameState,
  type Player,
  type Tuning,
} from "./types.js";

/**
 * Rendering a player and a realm for Discord.
 *
 * Split from the engine so the game can be tested without discord.js, and from
 * the command so the same character sheet can be produced by /old-idlerpg whoami,
 * /old-idlerpg status and anything added later.
 */

export function characterSheet(
  player: Player,
  state: GameState,
  tuning: Tuning = DEFAULT_TUNING,
): EmbedBuilder {
  const rank =
    Object.values(state.players)
      .sort((a, b) => b.level - a.level || a.next - b.next)
      .findIndex((p) => p.userId === player.userId) + 1;

  const penalties = player.penalties.message + player.penalties.logout + player.penalties.quest;

  const embed = new EmbedBuilder()
    .setTitle(`${player.name} — level ${player.level} ${player.charClass}`)
    .setColor(player.online ? 0x2ecc71 : 0x95a5a6)
    .addFields(
      {
        name: "Next level",
        value: player.online ? duration(player.next) : `${duration(player.next)} (idle stopped)`,
        inline: true,
      },
      { name: "Item sum", value: `${itemSum(player)}`, inline: true },
      { name: "Alignment", value: player.alignment, inline: true },
      { name: "Rank", value: `#${rank} of ${Object.keys(state.players).length}`, inline: true },
      { name: "Idled", value: duration(player.idled), inline: true },
      { name: "Position", value: `[${player.x}, ${player.y}]`, inline: true },
    );

  if (penalties > 0) {
    embed.addFields({
      name: "Time lost to penalties",
      value: [
        `Talking: ${duration(player.penalties.message)}`,
        `Logging out: ${duration(player.penalties.logout)}`,
        `Quests: ${duration(player.penalties.quest)}`,
      ].join("\n"),
    });
  }

  embed.setFooter({
    text: `Level ${player.level + 1} costs ${duration(timeToLevel(player.level + 1, tuning))} of idling.`,
  });

  return embed;
}

export function itemList(player: Player): string {
  const rows = ITEM_SLOTS.map((slot) => {
    const item = player.items[slot];
    const level = item?.level ?? 0;
    const name = item?.unique ? ` — *${item.unique}*` : "";
    return `\`${String(level).padStart(4)}\` ${SLOT_NAMES[slot]}${name}`;
  });
  return [`**${player.name}**'s equipment (sum ${itemSum(player)}):`, ...rows].join("\n");
}

export function leaderboard(state: GameState, limit: number): string {
  const ranked = Object.values(state.players)
    .sort((a, b) => b.level - a.level || a.next - b.next)
    .slice(0, limit);

  if (ranked.length === 0) return "Nobody has registered yet. `/old-idlerpg register` starts a character.";

  return [
    "**Idle RPG — the realm**",
    ...ranked.map((p, i) => {
      const dot = p.online ? "🟢" : "⚫";
      return (
        `\`${String(i + 1).padStart(2)}\` ${dot} **${p.name}** — level ${p.level} ` +
        `${p.charClass}, next in ${duration(p.next)}`
      );
    }),
  ].join("\n");
}

export function questLine(state: GameState, now: number): string {
  const quest = state.quest;
  const names = (ids: string[]) =>
    ids
      .map((id) => state.players[id]?.name ?? "someone")
      .map((n) => `**${n}**`)
      .join(", ");

  if (quest.kind === "idle") {
    const wait = quest.nextAt - Math.floor(now / 1000);
    return wait > 0
      ? `No quest is running. The gods will choose again in ${duration(wait)}.`
      : "No quest is running. The gods are looking for four worthy players.";
  }

  if (quest.kind === "time") {
    return [
      `${names(quest.questers)} are on a quest to ${quest.text}.`,
      `Time remaining: ${duration(quest.endsAt - Math.floor(now / 1000))}.`,
    ].join("\n");
  }

  const target = quest.stage === 1 ? quest.p1 : quest.p2;
  const distances = quest.questers.map((id) => {
    const p = state.players[id];
    if (!p) return "someone: unknown";
    const steps = Math.max(Math.abs(p.x - target.x), Math.abs(p.y - target.y));
    return `${p.name}: ${steps} step${steps === 1 ? "" : "s"} away`;
  });

  return [
    `${names(quest.questers)} are on a quest to ${quest.text}.`,
    `Heading for waypoint ${quest.stage} at [${target.x}, ${target.y}].`,
    ...distances.map((d) => `• ${d}`),
  ].join("\n");
}

/**
 * Packs lines into as few messages as Discord will take, never splitting a
 * line across two.
 *
 * A single level-up is four lines and a busy tick is dozens; posting each as
 * its own message would make the game unreadable and spend the channel's rate
 * limit on whitespace. A line longer than the limit on its own is truncated
 * rather than dropped -- losing a battle result entirely is worse than losing
 * its tail.
 */
export function batch(lines: string[], limit: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    const piece = line.length > limit ? `${line.slice(0, limit - 1)}\u2026` : line;
    if (current.length + piece.length + 1 > limit) {
      if (current) out.push(current);
      current = piece;
      continue;
    }
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current) out.push(current);
  return out;
}
