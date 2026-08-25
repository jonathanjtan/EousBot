import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { log } from "../log.js";
import {
  MIN_PLAYERS,
  endGame,
  joinGame,
  leaveLobby,
  living,
  nightAction,
  openGame,
  playerIn,
  resolveDay,
  resolveNight,
  roleSpread,
  startGame,
  vote,
} from "../rpg/werewolf.js";
import { save, world } from "../rpg/store.js";
import type { Werewolf, WerewolfRole } from "../rpg/types.js";
import type { Command } from "./types.js";

/**
 * Werewolf.
 *
 * Its own command for the same reason chess is: it shares nothing with the RPG
 * but a channel, and burying a party game inside an idle game's subcommand tree
 * is a good way to ensure nobody ever finds it.
 *
 * Every rule lives in src/rpg/werewolf.ts. This file's only real job is
 * secrecy -- roles go out by DM, night actions and seer results are ephemeral,
 * and nothing that would spoil the game is ever posted to the channel.
 */

const ROLE_BRIEF: Record<WerewolfRole, string> = {
  wolf: "**You are a wolf.** Each night, agree with the other wolves on somebody to take. By day, do not sound like a wolf.",
  seer: "**You are the seer.** Each night you may look at one person and learn what they are. Say too much and you will be the first to hang.",
  guard: "**You are the guard.** Each night you may protect one person from the wolves. Not yourself.",
  villager: "**You are a villager.** You have no power and no information. You have a vote, and an opinion.",
};

const HELP = [
  "**Werewolf.** The village is trying to find the wolves before the wolves finish",
  "the village.",
  "",
  "```",
  "/werewolf open · join · leave",
  "/werewolf start              deals roles by DM (host)",
  "/werewolf night player:@x    your night action, privately",
  "/werewolf dawn               resolve the night (host)",
  "/werewolf vote player:@x     accuse somebody",
  "/werewolf dusk               resolve the vote (host)",
  "/werewolf status · end",
  "```",
  "**Roles.** Roughly a quarter are wolves. There is always a seer, and a guard",
  "once there are six of you. Everyone else is a villager with a vote and an",
  "opinion.",
  "",
  "`wolf` — agree with the pack each night on somebody to take. Majority decides;",
  "a split pack kills nobody.",
  "`seer` — look at one person each night and learn what they are. You find out",
  "immediately, and privately.",
  "`guard` — protect one person from the wolves each night. Not yourself.",
  "",
  "**Phases advance when the host calls them**, not on a timer — a timed night",
  "ends at 3am for whoever was asleep.",
  "",
  "**The wolves win at parity**, not majority: once they equal the village they",
  "can never be out-voted, so playing on would be theatre.",
  "",
  "Five players minimum. Roles arrive by DM, so open yours to the bot first.",
].join("\n");

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("werewolf")
    .setDescription("A game of werewolf, run at the host's pace")
    .addSubcommand((s) => s.setName("open").setDescription("Open a lobby"))
    .addSubcommand((s) => s.setName("join").setDescription("Join the lobby"))
    .addSubcommand((s) => s.setName("leave").setDescription("Leave the lobby"))
    .addSubcommand((s) => s.setName("start").setDescription("Deal roles and begin (host)"))
    .addSubcommand((s) =>
      s
        .setName("night")
        .setDescription("Your night action, in private")
        .addUserOption((o) => o.setName("player").setDescription("Your target").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("dawn").setDescription("Resolve the night (host)"))
    .addSubcommand((s) =>
      s
        .setName("vote")
        .setDescription("Vote to hang somebody")
        .addUserOption((o) => o.setName("player").setDescription("The accused").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("dusk").setDescription("Resolve the vote (host)"))
    .addSubcommand((s) => s.setName("status").setDescription("Who is alive, and whose turn it is"))
    .addSubcommand((s) => s.setName("end").setDescription("Abandon the game (host)"))
    .addSubcommand((s) => s.setName("help").setDescription("The roles, the phases, and who calls them")),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "open":
        return doOpen(interaction);
      case "join":
      case "leave":
        return doLobby(interaction, sub === "join");
      case "start":
        return doStart(interaction);
      case "night":
        return doNight(interaction);
      case "dawn":
        return doDawn(interaction);
      case "vote":
        return doVote(interaction);
      case "dusk":
        return doDusk(interaction);
      case "status":
        return doStatus(interaction);
      case "end":
        return doEnd(interaction);
      case "help":
        await interaction.reply({ content: HELP, flags: MessageFlags.Ephemeral });
        return;
    }
  },
};

type I = ChatInputCommandInteraction;

async function whisper(interaction: I, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Names for ids. Falls back rather than throwing on somebody who left. */
function namer(interaction: I) {
  return (id: string) =>
    interaction.client.users.cache.get(id)?.username ?? `<@${id}>`;
}

function roster(game: Werewolf, nameOf: (id: string) => string): string {
  return game.players
    .map((p) => (p.alive ? `▫️ ${nameOf(p.userId)}` : `☠️ ~~${nameOf(p.userId)}~~`))
    .join("\n");
}

async function doOpen(interaction: I): Promise<void> {
  const result = openGame(world(), interaction.user.id);
  if (!result.ok) return whisper(interaction, result.reason);
  save();
  await interaction.reply(
    [
      `**Werewolf.** ${interaction.user.username} is hosting.`,
      `\`/werewolf join\` to play. ${MIN_PLAYERS} needed to start.`,
    ].join("\n"),
  );
}

async function doLobby(interaction: I, joining: boolean): Promise<void> {
  const result = joining
    ? joinGame(world(), interaction.user.id)
    : leaveLobby(world(), interaction.user.id);
  if (!result.ok) return whisper(interaction, result.reason);
  save();
  await interaction.reply(
    `**${interaction.user.username}** ${joining ? "joined" : "left"}. ` +
      `${result.value.players.length} in the lobby.`,
  );
}

/**
 * Deals roles and DMs each player theirs.
 *
 * A failed DM is reported to the host rather than swallowed: a player who never
 * learned they were the seer will simply play badly, and nobody will understand
 * why until the game is over.
 */
async function doStart(interaction: I): Promise<void> {
  const state = world();
  const result = startGame(state, interaction.user.id, Math.random);
  if (!result.ok) return whisper(interaction, result.reason);
  save();

  const game = result.value;
  await interaction.deferReply();

  const undelivered: string[] = [];
  const packmates = game.players.filter((p) => p.role === "wolf");

  for (const player of game.players) {
    const brief = [ROLE_BRIEF[player.role]];
    if (player.role === "wolf" && packmates.length > 1) {
      const others = packmates
        .filter((p) => p.userId !== player.userId)
        .map((p) => `<@${p.userId}>`)
        .join(", ");
      brief.push(`Your pack: ${others}.`);
    }
    brief.push("", "`/werewolf night player:@somebody` when it is dark. It stays private.");

    try {
      const user = await interaction.client.users.fetch(player.userId);
      await user.send(brief.join("\n"));
    } catch (err) {
      undelivered.push(`<@${player.userId}>`);
      log.debug("Could not DM a werewolf role", { userId: player.userId, err: String(err) });
    }
  }

  const spread = roleSpread(game.players.length);
  await interaction.editReply(
    [
      `**Night ${game.night}.** ${game.players.length} players: ` +
        `${spread.wolf} wolf${spread.wolf === 1 ? "" : "s"}, a seer` +
        (spread.guard > 0 ? ", a guard" : "") +
        `, and ${spread.villager} villager${spread.villager === 1 ? "" : "s"}.`,
      "Roles have been sent by DM. `/werewolf dawn` when everyone has acted.",
      ...(undelivered.length > 0
        ? ["", `⚠️ Could not DM ${undelivered.join(", ")} — their DMs are closed.`]
        : []),
    ].join("\n"),
  );
}

async function doNight(interaction: I): Promise<void> {
  const target = interaction.options.getUser("player", true);
  const result = nightAction(world(), interaction.user.id, target.id);
  if (!result.ok) return whisper(interaction, result.reason);
  save();

  const v = result.value;
  if (v.role === "seer") {
    // The one piece of information in the game. Ephemeral, always.
    return whisper(interaction, `**${target.username}** is a **${v.seerSaw}**.`);
  }
  return whisper(
    interaction,
    v.role === "wolf"
      ? `You have named **${target.username}**. The pack decides by majority.`
      : `You are guarding **${target.username}** tonight.`,
  );
}

async function doDawn(interaction: I): Promise<void> {
  const state = world();
  const result = resolveNight(state, interaction.user.id);
  if (!result.ok) return whisper(interaction, result.reason);
  save();

  const v = result.value;
  const nameOf = namer(interaction);
  const opening =
    v.victimId === null
      ? v.saved
        ? "The wolves came for somebody and found them guarded. Everyone wakes."
        : "The wolves could not agree. Everyone wakes."
      : `**${nameOf(v.victimId)}** did not wake up.`;

  await interaction.reply(
    [
      `**Dawn.**`,
      opening,
      "",
      roster(v.game, nameOf),
      "",
      ...(v.game.phase === "over"
        ? [`**The ${v.game.winner} win.**`]
        : ["`/werewolf vote player:@somebody`, then the host calls `/werewolf dusk`."]),
    ].join("\n"),
  );
}

async function doVote(interaction: I): Promise<void> {
  const target = interaction.options.getUser("player", true);
  const result = vote(world(), interaction.user.id, target.id);
  if (!result.ok) return whisper(interaction, result.reason);
  save();
  // Public, because the argument is the game.
  await interaction.reply(`**${interaction.user.username}** votes for **${target.username}**.`);
}

async function doDusk(interaction: I): Promise<void> {
  const state = world();
  const result = resolveDay(state, interaction.user.id);
  if (!result.ok) return whisper(interaction, result.reason);
  save();

  const v = result.value;
  const nameOf = namer(interaction);
  const verdict =
    v.lynchedId === null
      ? "The village could not agree. Nobody hangs."
      : `**${nameOf(v.lynchedId)}** hangs, and was a **${v.role}**.`;

  await interaction.reply(
    [
      "**Dusk.**",
      verdict,
      "",
      roster(v.game, nameOf),
      "",
      ...(v.game.phase === "over"
        ? [`**The ${v.game.winner} win.**`]
        : [`**Night ${v.game.night}.** Act, then the host calls \`/werewolf dawn\`.`]),
    ].join("\n"),
  );
}

async function doStatus(interaction: I): Promise<void> {
  const game = world().werewolf;
  if (!game) return whisper(interaction, "No game is running. `/werewolf open` starts one.");

  const nameOf = namer(interaction);
  const you = playerIn(game, interaction.user.id);
  await interaction.reply({
    content: [
      game.phase === "lobby"
        ? `**Lobby** — ${game.players.length} in, ${MIN_PLAYERS} needed.`
        : `**${game.phase === "night" ? `Night ${game.night}` : "Day"}** — ` +
          `${living(game).length} alive of ${game.players.length}.`,
      "",
      roster(game, nameOf),
      ...(you ? ["", `_You are a **${you.role}**${you.alive ? "" : ", and dead"}._`] : []),
    ].join("\n"),
    // Ephemeral because it names the viewer's own role.
    flags: MessageFlags.Ephemeral,
  });
}

async function doEnd(interaction: I): Promise<void> {
  const result = endGame(world(), interaction.user.id);
  if (!result.ok) return whisper(interaction, result.reason);
  save();

  const nameOf = namer(interaction);
  await interaction.reply(
    [
      "**Game abandoned.** For the record:",
      ...result.value.players.map((p) => `${nameOf(p.userId)} — ${p.role}`),
    ].join("\n"),
  );
}
