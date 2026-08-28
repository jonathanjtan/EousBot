import { EmbedBuilder } from "discord.js";
import { eventDays, eventPopulations } from "./engine.js";
import {
  DEFAULT_TUNING,
  duration,
  expectedInterval,
  itemSum,
  timeToLevel,
} from "./rules.js";
import {
  ITEM_SLOTS,
  SLOT_NAMES,
  WORLD_EVENTS,
  type GameState,
  type Player,
  type Tuning,
  type WorldEvent,
} from "./types.js";

/**
 * Rendering a player and a realm for Discord.
 *
 * Split from the engine so the game can be tested without discord.js, and from
 * the command so the same character sheet can be produced by /old-idlerpg whoami,
 * /old-idlerpg status and anything added later.
 */

/**
 * Why a clock is not moving, in the player's own terms.
 *
 * A stopped clock used to render as a bare "(idle stopped)", which named the
 * symptom and none of the three quite different causes. A player cannot act on
 * the symptom, and a frozen realm was undiscoverable from inside the game.
 */
function clockNote(player: Player, state: GameState): string {
  if (state.paused) return " (the realm is frozen)";
  if (player.suspended) return " (idle stopped; `/old-idlerpg login` restarts it)";
  if (!player.online) return " (idle stopped; your clock runs only while you are online)";
  return "";
}

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
    .setTitle(`${player.name}, level ${player.level} ${player.charClass}`)
    .setColor(player.online && !state.paused ? 0x2ecc71 : 0x95a5a6)
    .addFields(
      {
        name: "Next level",
        value: `${duration(player.next)}${clockNote(player, state)}`,
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
    const name = item?.unique ? `, *${item.unique}*` : "";
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
    "Idle RPG, the realm",
    ...ranked.map((p, i) => {
      const dot = p.online ? "🟢" : "⚫";
      return (
        `\`${String(i + 1).padStart(2)}\` ${dot} **${p.name}**, level ${p.level} ` +
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

const EVENT_NAMES: Record<WorldEvent, string> = {
  handOfGod: "hand of God",
  teamBattle: "team battle",
  calamity: "calamity",
  godsend: "godsend",
  evilness: "evilness",
  goodness: "goodness",
};

/** What each event's rate is counted per, for the "at N" clause. */
const EVENT_SCALE: Record<WorldEvent, string> = {
  handOfGod: "online",
  teamBattle: "online",
  calamity: "online",
  godsend: "online",
  evilness: "evil and online",
  goodness: "good and online",
};

/**
 * Every world event, how often it has fired and how often it should.
 *
 * The question this answers is "is the hand of God broken", and the answer is
 * almost always no: at one occurrence per online player per twenty days, a
 * realm of three goes a week between them, and a week of silence is exactly
 * what a dead event looks like too. Printing the expected interval next to the
 * observed count is the only way to tell those apart without reading the code.
 */
export function eventReport(state: GameState, now: number): string {
  const nowSeconds = Math.floor(now / 1000);
  const population = eventPopulations(state);
  const days = eventDays(state, now);
  const online = Object.values(state.players).filter((p) => p.online).length;

  const rows = WORLD_EVENTS.map((kind) => {
    const record = state.events[kind];
    const every = expectedInterval(days[kind], population[kind]);
    const rate = Number.isFinite(every)
      ? `Expected one every ${duration(every)} at ${population[kind]} ${EVENT_SCALE[kind]}`
      : `Nobody is ${EVENT_SCALE[kind]}, so it cannot fire`;
    const seen =
      record.count === 0
        ? "never fired"
        : `fired ${record.count}, last ${duration(nowSeconds - record.lastAt)} ago`;
    return `\`${EVENT_NAMES[kind].padEnd(11)}\` ${seen}. ${rate}.`;
  });

  const clock = state.paused
    ? "The realm is frozen, so nothing rolls."
    : `The realm is running. Last tick ${duration(nowSeconds - state.lastTick)} ago.`;

  // The temporary rate says so where the rate is read, or the next admin to
  // look would take the boosted number for the game's own.
  const boostEnds = state.hogBoostUntil ?? 0;
  const boost =
    boostEnds > nowSeconds
      ? `The hand of God is turned up 19x for the next ${duration(boostEnds - nowSeconds)}, ` +
        "to check it fires at all. It returns to one per player per twenty days by itself."
      : "";

  return [
    `**Idle RPG world events**, ${online} online`,
    clock,
    ...(boost ? [boost] : []),
    "",
    ...rows,
    "",
    "Counted from the tick only, so a summoned hand of God is not in here. " +
      "A realm that was saved before this tally existed starts from zero.",
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

/**
 * The same lines, stamped with the game that produced them.
 *
 * Both games narrate into one channel, and "Grimwald has attained level 12"
 * reads the same whichever of them said it. The tag is what tells them apart.
 *
 * Every chunk carries it, not only the first: a tick long enough to split in
 * two would otherwise leave the second message unattributed, which is the case
 * the tag exists for. The limit shrinks by the header so a stamped chunk still
 * fits what Discord will take.
 */
export function labelled(label: string, lines: string[], limit: number): string[] {
  const header = `${label}\n`;
  return batch(lines, limit - header.length).map((chunk) => `${header}${chunk}`);
}
