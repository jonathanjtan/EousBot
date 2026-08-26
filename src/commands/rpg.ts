import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { CLASS_IDS, GOD_IDS, RACE_IDS } from "../rpg/content.js";
import { HELP_PAGES, helpPage } from "../rpg/help.js";
import { isAdmin } from "../config.js";
import {
  claimExpedition,
  create,
  duel,
  equip,
  find,
  findByName,
  openCrate,
  sell,
  sellAll,
  startExpedition,
} from "../rpg/engine.js";
import {
  RANK_METRICS,
  adventureTable,
  backpack,
  claimMessage,
  classMenu,
  describe,
  profile,
  raceMenu,
  ranking,
} from "../rpg/format.js";
import {
  handleBet,
  handleGive,
  handleGod,
  handleGuild,
  handleMarket,
  handleMarry,
  handleRaid,
  handleStore,
  handleTournament,
  handleAdmin,
  handleArena,
  handleEvent,
  handleMaths,
  handleSeason,
  handleTopBoard,
  handleTrivia,
  completeMarriage,
} from "./rpgsocial.js";
import { DEFAULT_TUNING, coin } from "../rpg/rules.js";
import { save, world } from "../rpg/store.js";
import { RARITIES, type ClassId, type RaceId, type Rarity } from "../rpg/types.js";
import type { Command } from "./types.js";

/**
 * The dispatch-and-claim RPG.
 *
 * Takes the `/idlerpg` name because it is the game people will actually play;
 * jotun's original keeps its mechanics intact under `/old-idlerpg`. See
 * src/rpg/types.ts for why there are two.
 *
 * Every handler is a shell over src/rpg/engine.ts. Where one looks like it is
 * deciding something, it is deciding what to *show*.
 */

function ctx() {
  return { rng: Math.random, now: Date.now(), tuning: DEFAULT_TUNING };
}

export const DUEL_PREFIX = "rpg:duel";

/** `rpg:duel:<challenger>:<opponent>:<stake>`. Ids are snowflakes; stake is an integer. */
export function encodeDuel(challengerId: string, opponentId: string, stake: number): string {
  return `${DUEL_PREFIX}:${challengerId}:${opponentId}:${stake}`;
}

export function decodeDuel(
  customId: string,
): { challengerId: string; opponentId: string; stake: number } | null {
  const parts = customId.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== DUEL_PREFIX) return null;
  const stake = Number(parts[4]);
  if (!Number.isInteger(stake) || stake < 1) return null;
  return { challengerId: parts[2] as string, opponentId: parts[3] as string, stake };
}

export const MARRY_PREFIX = "rpg:marry";

/** `rpg:marry:<proposer>:<target>`. Same shape and reasoning as the duel codec. */
export function encodeMarry(proposerId: string, targetId: string): string {
  return `${MARRY_PREFIX}:${proposerId}:${targetId}`;
}

export function decodeMarry(customId: string): { proposerId: string; targetId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== MARRY_PREFIX) return null;
  return { proposerId: parts[2] as string, targetId: parts[3] as string };
}

/** Resolves a proposal, but only for the player who was actually asked. */
export async function handleMarryButton(
  interaction: ButtonInteraction,
  target: { proposerId: string; targetId: string },
): Promise<void> {
  if (interaction.user.id !== target.targetId) {
    await interaction.reply({
      content: "That proposal is not yours to accept.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const result = await completeMarriage(target.proposerId, target.targetId);
  if (!result.ok) {
    await interaction.reply({ content: result.text, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.update({ content: result.text, components: [] });
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("idlerpg")
    .setDescription("Send a character out, come back to what it found")
    // Ten top-level subcommands and nine groups: 19 of Discord's 25 option
    // slots. The core loop stays flat because it is what people run daily;
    // everything that feeds it is grouped so the list stays readable.
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("Create a character")
        .addStringOption((o) =>
          o
            .setName("class")
            .setDescription("What your character is good at")
            .setRequired(true)
            .addChoices(...CLASS_IDS.map((id) => ({ name: id, value: id }))),
        )
        .addStringOption((o) =>
          o
            .setName("race")
            .setDescription("A smaller, permanent bonus")
            .addChoices(...RACE_IDS.map((id) => ({ name: id, value: id }))),
        )
        .addStringOption((o) =>
          o.setName("name").setDescription("Character name. Defaults to your Discord name").setMaxLength(24),
        ),
    )
    .addSubcommand((s) => s.setName("classes").setDescription("What each class does"))
    .addSubcommand((s) => s.setName("races").setDescription("What each race does"))
    .addSubcommand((s) =>
      s
        .setName("profile")
        .setDescription("A character sheet")
        .addStringOption((o) => o.setName("player").setDescription("Character name").setMaxLength(24)),
    )
    .addSubcommand((s) => s.setName("adventures").setDescription("Where you could go, and the odds"))
    .addSubcommand((s) =>
      s
        .setName("adventure")
        .setDescription("Go somewhere")
        .addIntegerOption((o) =>
          o.setName("difficulty").setDescription("Higher pays more and fails more").setRequired(true).setMinValue(1).setMaxValue(30),
        ),
    )
    .addSubcommand((s) => s.setName("status").setDescription("How long until you are back"))
    .addSubcommand((s) => s.setName("claim").setDescription("Collect what you found"))
    .addSubcommand((s) =>
      s
        .setName("top")
        .setDescription("The realm, ranked")
        .addStringOption((o) =>
          o
            .setName("by")
            .setDescription("Which board (default level)")
            .addChoices(...RANK_METRICS.map((m) => ({ name: m, value: m }))),
        )
        .addIntegerOption((o) => o.setName("count").setDescription("How many (default 10)").setMinValue(1).setMaxValue(25)),
    )
    .addSubcommand((s) =>
      s
        .setName("duel")
        .setDescription("Wager coin against another player")
        .addUserOption((o) => o.setName("player").setDescription("Who to challenge").setRequired(true))
        .addIntegerOption((o) => o.setName("stake").setDescription("Coin each").setRequired(true).setMinValue(1)),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("item")
        .setDescription("Your gear")
        .addSubcommand((s) => s.setName("backpack").setDescription("What you are carrying"))
        .addSubcommand((s) =>
          s
            .setName("equip")
            .setDescription("Wear something from your backpack")
            .addIntegerOption((o) => o.setName("item").setDescription("Item number").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName("sell")
            .setDescription("Sell one item to the shop")
            .addIntegerOption((o) => o.setName("item").setDescription("Item number").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName("sellall")
            .setDescription("Sell the junk")
            .addIntegerOption((o) => o.setName("keep_above").setDescription("Keep anything better than this").setMinValue(0)),
        )
        .addSubcommand((s) =>
          s
            .setName("open")
            .setDescription("Open a crate")
            .addStringOption((o) =>
              o.setName("rarity").setDescription("Which crate").setRequired(true).addChoices(...RARITIES.map((r) => ({ name: r, value: r }))),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("give")
            .setDescription("Hand coin or an item to another player")
            .addUserOption((o) => o.setName("player").setDescription("Who to give to").setRequired(true))
            .addIntegerOption((o) => o.setName("coin").setDescription("How much coin").setMinValue(1))
            .addIntegerOption((o) => o.setName("item").setDescription("Item number").setMinValue(1)),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("god")
        .setDescription("Faith, sacrifice, and better odds")
        .addSubcommand((s) => s.setName("list").setDescription("Who you could follow"))
        .addSubcommand((s) => s.setName("status").setDescription("Your standing"))
        .addSubcommand((s) =>
          s
            .setName("follow")
            .setDescription("Swear to a god")
            .addStringOption((o) =>
              o.setName("god").setDescription("Which one").setRequired(true).addChoices(...GOD_IDS.map((id) => ({ name: id, value: id }))),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("sacrifice")
            .setDescription("Give up items for favour")
            .addStringOption((o) =>
              o.setName("items").setDescription("Item numbers, space or comma separated").setRequired(true).setMaxLength(200),
            ),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("store")
        .setDescription("Buy crates with coin")
        .addSubcommand((s) => s.setName("list").setDescription("What is for sale"))
        .addSubcommand((s) =>
          s
            .setName("buy")
            .setDescription("Buy crates")
            .addStringOption((o) =>
              o.setName("rarity").setDescription("Which crate").setRequired(true).addChoices(...RARITIES.map((r) => ({ name: r, value: r }))),
            )
            .addIntegerOption((o) => o.setName("count").setDescription("How many (default 1)").setMinValue(1).setMaxValue(50)),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("guild")
        .setDescription("Found one, run one, fight one")
        .addSubcommand((s) =>
          s
            .setName("create")
            .setDescription("Found a guild")
            .addStringOption((o) => o.setName("name").setDescription("Guild name").setRequired(true).setMaxLength(32)),
        )
        .addSubcommand((s) =>
          s
            .setName("join")
            .setDescription("Join a guild")
            .addStringOption((o) => o.setName("name").setDescription("Guild name").setRequired(true).setMaxLength(32)),
        )
        .addSubcommand((s) => s.setName("leave").setDescription("Leave your guild"))
        .addSubcommand((s) =>
          s
            .setName("info")
            .setDescription("A guild's roster and bank")
            .addStringOption((o) => o.setName("name").setDescription("Guild name, or blank for yours").setMaxLength(32)),
        )
        .addSubcommand((s) => s.setName("list").setDescription("Every guild"))
        .addSubcommand((s) =>
          s
            .setName("kick")
            .setDescription("Remove a member")
            .addUserOption((o) => o.setName("player").setDescription("Who").setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName("promote")
            .setDescription("Make somebody an officer")
            .addUserOption((o) => o.setName("player").setDescription("Who").setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName("demote")
            .setDescription("Remove an officer")
            .addUserOption((o) => o.setName("player").setDescription("Who").setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName("handover")
            .setDescription("Give the guild to somebody else")
            .addUserOption((o) => o.setName("player").setDescription("Who").setRequired(true)),
        )
        .addSubcommand((s) => s.setName("disband").setDescription("Dissolve the guild"))
        .addSubcommand((s) =>
          s
            .setName("deposit")
            .setDescription("Put coin in the bank")
            .addIntegerOption((o) => o.setName("coin").setDescription("How much").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName("withdraw")
            .setDescription("Take coin out (leaders and officers)")
            .addIntegerOption((o) => o.setName("coin").setDescription("How much").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) => s.setName("upgrade").setDescription("Raise the member cap, from the bank"))
        .addSubcommand((s) =>
          s
            .setName("ally")
            .setDescription("Fly under another guild's banner")
            .addStringOption((o) => o.setName("name").setDescription("Guild name").setRequired(true).setMaxLength(32)),
        )
        .addSubcommand((s) => s.setName("unally").setDescription("Leave the alliance"))
        .addSubcommand((s) =>
          s
            .setName("battle")
            .setDescription("Wager bank against another guild")
            .addStringOption((o) => o.setName("name").setDescription("Guild name").setRequired(true).setMaxLength(32))
            .addIntegerOption((o) => o.setName("stake").setDescription("Coin from each bank").setRequired(true).setMinValue(1)),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("market")
        .setDescription("Buy and sell between players")
        .addSubcommand((s) => s.setName("list").setDescription("What is listed"))
        .addSubcommand((s) =>
          s
            .setName("sell")
            .setDescription("List an item")
            .addIntegerOption((o) => o.setName("item").setDescription("Item number").setRequired(true).setMinValue(1))
            .addIntegerOption((o) => o.setName("price").setDescription("Asking price").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName("buy")
            .setDescription("Buy a listing")
            .addIntegerOption((o) => o.setName("listing").setDescription("Listing number").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) =>
          s
            .setName("unlist")
            .setDescription("Take your listing down")
            .addIntegerOption((o) => o.setName("listing").setDescription("Listing number").setRequired(true).setMinValue(1)),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("raid")
        .setDescription("Everyone against one boss")
        .addSubcommand((s) => s.setName("call").setDescription("Summon a boss, and seed the pot"))
        .addSubcommand((s) => s.setName("hit").setDescription("Take a swing"))
        .addSubcommand((s) => s.setName("status").setDescription("How the fight is going")),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("tournament")
        .setDescription("A bracket, for money")
        .addSubcommand((s) =>
          s
            .setName("open")
            .setDescription("Open entries")
            .addIntegerOption((o) => o.setName("buy_in").setDescription("Coin per entry").setMinValue(0)),
        )
        .addSubcommand((s) => s.setName("join").setDescription("Enter"))
        .addSubcommand((s) => s.setName("run").setDescription("Run the bracket"))
        .addSubcommand((s) => s.setName("status").setDescription("Who is in")),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("marry")
        .setDescription("A joint bonus, and somebody to spend on")
        .addSubcommand((s) =>
          s
            .setName("propose")
            .setDescription("Ask somebody")
            .addUserOption((o) => o.setName("player").setDescription("Who").setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName("court")
            .setDescription("Spend coin to raise the bonus for both of you")
            .addIntegerOption((o) => o.setName("coin").setDescription("How much").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) => s.setName("divorce").setDescription("End it"))
        .addSubcommand((s) => s.setName("status").setDescription("How it is going")),
    )
    .addSubcommand((s) =>
      s
        .setName("help")
        .setDescription("How any of this works")
        .addStringOption((o) =>
          o
            .setName("topic")
            .setDescription("Which part (the overview if omitted)")
            .addChoices(...HELP_PAGES.map((p) => ({ name: `${p.topic}, ${p.summary}`.slice(0, 100), value: p.topic }))),
        ),
    )
    .addSubcommand((s) => s.setName("trivia").setDescription("A question, for coin"))
    .addSubcommand((s) =>
      s
        .setName("maths")
        .setDescription("A sum, for coin")
        .addIntegerOption((o) =>
          o.setName("difficulty").setDescription("1-5; harder pays more").setMinValue(1).setMaxValue(5),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("arena")
        .setDescription("A free-for-all. Gear helps; it does not decide")
        .addSubcommand((s) =>
          s
            .setName("open")
            .setDescription("Open a match")
            .addIntegerOption((o) => o.setName("buy_in").setDescription("Coin per entrant").setMinValue(0)),
        )
        .addSubcommand((s) => s.setName("join").setDescription("Enter the match"))
        .addSubcommand((s) => s.setName("run").setDescription("Run it"))
        .addSubcommand((s) => s.setName("status").setDescription("Who is in")),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("admin")
        .setDescription("Operator controls")
        .addSubcommand((s) =>
          s
            .setName("grant")
            .setDescription("Give or take coin")
            .addUserOption((o) => o.setName("player").setDescription("Who").setRequired(true))
            .addIntegerOption((o) => o.setName("coin").setDescription("Negative takes it away").setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName("setlevel")
            .setDescription("Set a character's level")
            .addUserOption((o) => o.setName("player").setDescription("Who").setRequired(true))
            .addIntegerOption((o) => o.setName("level").setDescription("New level").setRequired(true).setMinValue(1).setMaxValue(200)),
        )
        .addSubcommand((s) =>
          s
            .setName("spawn")
            .setDescription("Create an item in somebody's backpack")
            .addUserOption((o) => o.setName("player").setDescription("Who").setRequired(true))
            .addIntegerOption((o) => o.setName("value").setDescription("Item value").setRequired(true).setMinValue(1).setMaxValue(10000))
            .addStringOption((o) =>
              o.setName("rarity").setDescription("Rarity").setRequired(true).addChoices(...RARITIES.map((r) => ({ name: r, value: r }))),
            )
            .addStringOption((o) =>
              o.setName("kind").setDescription("Weapon or armor").setRequired(true).addChoices(
                { name: "weapon", value: "weapon" },
                { name: "armor", value: "armor" },
              ),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("reset")
            .setDescription("Delete a character permanently")
            .addUserOption((o) => o.setName("player").setDescription("Who").setRequired(true)),
        )
        .addSubcommand((s) => s.setName("clear").setDescription("Clear a stuck raid, match or tournament"))
        .addSubcommand((s) =>
          s
            .setName("season")
            .setDescription("Start a long seasonal event")
            .addIntegerOption((o) =>
              o.setName("which").setDescription("Which season (random if omitted)").setMinValue(0).setMaxValue(3),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("event")
            .setDescription("Start a realm-wide event")
            .addStringOption((o) =>
              o.setName("kind").setDescription("Which one (random if omitted)").addChoices(
                { name: "bounty, double coin", value: "bounty" },
                { name: "study, double experience", value: "study" },
                { name: "fortune, more crates", value: "fortune" },
              ),
            ),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("bet")
        .setDescription("Wagers at fair odds")
        .addSubcommand((s) =>
          s
            .setName("flip")
            .setDescription("Coin flip, even money")
            .addIntegerOption((o) => o.setName("stake").setDescription("Coin").setRequired(true).setMinValue(1))
            .addStringOption((o) =>
              o.setName("call").setDescription("Heads or tails").setRequired(true).addChoices(
                { name: "heads", value: "heads" },
                { name: "tails", value: "tails" },
              ),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("dice")
            .setDescription("Guess a die roll; pays sides-1 to 1")
            .addIntegerOption((o) => o.setName("stake").setDescription("Coin").setRequired(true).setMinValue(1))
            .addIntegerOption((o) => o.setName("guess").setDescription("Your number").setRequired(true).setMinValue(1))
            .addIntegerOption((o) => o.setName("sides").setDescription("Die size (default 6)").setMinValue(2).setMaxValue(100)),
        ),
    ),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group) {
      switch (group) {
        case "item":
          return handleItem(interaction, sub);
        case "god":
          return handleGod(interaction, sub);
        case "store":
          return handleStore(interaction, sub);
        case "guild":
          return handleGuild(interaction, sub);
        case "market":
          return handleMarket(interaction, sub);
        case "raid":
          return handleRaid(interaction, sub);
        case "tournament":
          return handleTournament(interaction, sub);
        case "marry":
          return handleMarryGroup(interaction, sub);
        case "bet":
          return handleBet(interaction, sub);
        case "arena":
          return handleArena(interaction, sub);
        case "admin": {
          // Checked here rather than with `adminOnly` on the command: the rest
          // of /idlerpg is for everyone, and that flag is all-or-nothing.
          if (!isAdmin(interaction.user.id)) {
            await interaction.reply({
              content: "The admin controls are restricted to the bot's admins.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (sub === "event") return handleEvent(interaction);
          if (sub === "season") return handleSeason(interaction);
          return handleAdmin(interaction, sub);
        }
      }
    }

    switch (sub) {
      case "start":
        return doStart(interaction);
      case "classes":
        await interaction.reply({ content: classMenu(), flags: MessageFlags.Ephemeral });
        return;
      case "races":
        await interaction.reply({ content: raceMenu(), flags: MessageFlags.Ephemeral });
        return;
      case "profile":
        return doProfile(interaction);
      case "adventures":
        return doAdventures(interaction);
      case "adventure":
        return doAdventure(interaction);
      case "status":
        return doStatus(interaction);
      case "claim":
        return doClaim(interaction);
      case "duel":
        return doDuel(interaction);
      case "top":
        return handleTopBoard(interaction);
      case "help":
        await interaction.reply({
          content: helpPage(interaction.options.getString("topic")),
          flags: MessageFlags.Ephemeral,
        });
        return;
      case "trivia":
        return handleTrivia(interaction);
      case "maths":
        return handleMaths(interaction);
      default:
        await interaction.reply({ content: helpPage(null), flags: MessageFlags.Ephemeral });
        return;
    }
  },
};

/** The `item` group, whose handlers already lived here. */
async function handleItem(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  switch (sub) {
    case "backpack":
      return doBackpack(interaction);
    case "equip":
      return doEquip(interaction);
    case "sell":
      return doSell(interaction, false);
    case "sellall":
      return doSell(interaction, true);
    case "open":
      return doOpen(interaction);
    case "give":
      return handleGive(interaction);
  }
}

/** Proposing needs consent, so it is a button; the rest is plain. */
async function handleMarryGroup(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  if (sub !== "propose") return handleMarry(interaction, sub);

  const target = interaction.options.getUser("player", true);
  const state = world();
  if (!find(state, interaction.user.id)) {
    await interaction.reply({ content: NO_CHARACTER, flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.bot || !find(state, target.id)) {
    await interaction.reply({
      content: `${target.username} has no character.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (target.id === interaction.user.id) {
    await interaction.reply({ content: "You cannot marry yourself.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({
    content: `<@${target.id}>, **${interaction.user.username}** is proposing.`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeMarry(interaction.user.id, target.id))
          .setLabel("Accept")
          .setEmoji("💍")
          .setStyle(ButtonStyle.Success),
      ),
    ],
  });
}

type Interaction = ChatInputCommandInteraction;

/** Everything except `start` needs a character; this is the one gate. */
function mine(interaction: Interaction) {
  return find(world(), interaction.user.id);
}

const NO_CHARACTER = "You have no character yet. `/idlerpg start` makes one.";

async function doStart(interaction: Interaction): Promise<void> {
  const classId = interaction.options.getString("class", true) as ClassId;
  const raceId = (interaction.options.getString("race") ?? "human") as RaceId;
  const name = (interaction.options.getString("name") ?? interaction.user.username).trim();

  // Names go into channel messages, so anything that could impersonate another
  // member or ping a role is refused rather than escaped.
  if (!/^[\w '\-]{1,24}$/.test(name)) {
    await interaction.reply({
      content: "Character names are letters, numbers, spaces, apostrophes and hyphens only.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = create(world(), interaction.user.id, name, classId, ctx(), raceId);
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();

  await interaction.reply({
    content: [
      `**${result.character.name}** the ${raceId} ${classId} is ready, with ${coin(result.character.money)} and a starting kit.`,
      "",
      "`/idlerpg adventures` shows where you can go and what the odds are.",
    ].join("\n"),
    embeds: [profile(result.character)],
  });
}

async function doProfile(interaction: Interaction): Promise<void> {
  const wanted = interaction.options.getString("player");
  const character = wanted ? findByName(world(), wanted) : mine(interaction);
  if (!character) {
    await interaction.reply({
      content: wanted ? `Nobody is called ${wanted}.` : NO_CHARACTER,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({ embeds: [profile(character)] });
}

async function doAdventures(interaction: Interaction): Promise<void> {
  const character = mine(interaction);
  if (!character) {
    await interaction.reply({ content: NO_CHARACTER, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ content: adventureTable(character), flags: MessageFlags.Ephemeral });
}

async function doAdventure(interaction: Interaction): Promise<void> {
  const difficulty = interaction.options.getInteger("difficulty", true);
  const result = startExpedition(world(), interaction.user.id, difficulty, ctx());
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();

  await interaction.reply(
    [
      `**${result.character.name}** has gone to ${result.name}.`,
      // One rendering of the time. <t:...:R> already reads as "in 1 hour",
      // so pairing it with a duration printed the same fact twice.
      `Difficulty ${result.difficulty}, back <t:${Math.floor(result.endsAt / 1000)}:R>.`,
      "",
      "_`/idlerpg claim` when time's up._",
    ].join("\n"),
  );
}

async function doStatus(interaction: Interaction): Promise<void> {
  const character = mine(interaction);
  if (!character) {
    await interaction.reply({ content: NO_CHARACTER, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!character.expedition) {
    await interaction.reply({
      content: "You are not on an adventure. `/idlerpg adventures` shows the options.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const left = character.expedition.endsAt - Date.now();
  await interaction.reply({
    content:
      left > 0
        ? `Difficulty ${character.expedition.difficulty}, back <t:${Math.floor(character.expedition.endsAt / 1000)}:R>.`
        : "You are back. `/idlerpg claim` to see how it went.",
    flags: MessageFlags.Ephemeral,
  });
}

async function doClaim(interaction: Interaction): Promise<void> {
  const result = claimExpedition(world(), interaction.user.id, ctx());

  if (result.kind === "none") {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  if (result.kind === "pending") {
    await interaction.reply({
      content: `Not back yet. Due <t:${Math.floor(result.endsAt / 1000)}:R>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  save();
  await interaction.reply({ embeds: [claimMessage(result.character, result.reward)] });
  for (const line of result.announcements) {
    await interaction.followUp(line.text);
  }
}

async function doBackpack(interaction: Interaction): Promise<void> {
  const character = mine(interaction);
  if (!character) {
    await interaction.reply({ content: NO_CHARACTER, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ content: backpack(character), flags: MessageFlags.Ephemeral });
}

async function doEquip(interaction: Interaction): Promise<void> {
  const result = equip(world(), interaction.user.id, interaction.options.getInteger("item", true));
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();
  await interaction.reply(
    `Equipped ${describe(result.item)}` +
      (result.replaced ? `, and put ${result.replaced.name} back in the pack.` : "."),
  );
}

async function doSell(interaction: Interaction, all: boolean): Promise<void> {
  const result = all
    ? sellAll(world(), interaction.user.id, interaction.options.getInteger("keep_above") ?? 0)
    : sell(world(), interaction.user.id, interaction.options.getInteger("item", true));

  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();
  await interaction.reply({
    content:
      result.count === 0
        ? "Nothing matched, so nothing was sold."
        : `Sold ${result.count} item${result.count === 1 ? "" : "s"} for ${coin(result.paid)}.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function doOpen(interaction: Interaction): Promise<void> {
  const rarity = interaction.options.getString("rarity", true) as Rarity;
  const result = openCrate(world(), interaction.user.id, rarity, ctx());
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();

  const lines = [`Out of the ${rarity} crate: ${describe(result.item)}`];
  if (result.equipped) {
    lines.push(
      result.replaced
        ? `Better than your ${result.replaced.name} (${result.replaced.value}), so it is equipped.`
        : "Equipped, since you had nothing in that slot.",
    );
  } else if (result.soldOverflow > 0) {
    lines.push(`Your backpack was full, so it sold immediately for ${coin(result.soldOverflow)}.`);
  } else {
    lines.push("Into the backpack with it.");
  }
  await interaction.reply(lines.join("\n"));
}

/**
 * Challenges another player, and waits for them to accept.
 *
 * The wager is not applied here. Moving somebody's coin because a third party
 * ran a command would be indefensible, so the duel only resolves once the
 * challenged player presses the button themselves.
 */
async function doDuel(interaction: Interaction): Promise<void> {
  const target = interaction.options.getUser("player", true);
  const stake = interaction.options.getInteger("stake", true);
  const state = world();

  const challenger = find(state, interaction.user.id);
  const opponent = find(state, target.id);
  if (!challenger) {
    await interaction.reply({ content: NO_CHARACTER, flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.bot || !opponent) {
    await interaction.reply({
      content: `${target.username} has no character.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (target.id === interaction.user.id) {
    await interaction.reply({ content: "You cannot duel yourself.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (challenger.money < stake || opponent.money < stake) {
    await interaction.reply({
      content: `Both of you need ${coin(stake)}. You have ${coin(challenger.money)}; ${opponent.name} has ${coin(opponent.money)}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content:
      `<@${target.id}>, **${challenger.name}** challenges you for ${coin(stake)}.\n` +
      `_Accept and the loser pays. Ignore it and nothing happens._`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeDuel(interaction.user.id, target.id, stake))
          .setLabel(`Accept, ${stake}`)
          .setEmoji("⚔️")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

/** Resolves a duel, but only for the player who was actually challenged. */
export async function handleDuelButton(
  interaction: ButtonInteraction,
  target: { challengerId: string; opponentId: string; stake: number },
): Promise<void> {
  if (interaction.user.id !== target.opponentId) {
    await interaction.reply({
      content: "That challenge is not yours to accept.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = duel(world(), target.challengerId, target.opponentId, target.stake, ctx());
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();

  const { winner, loser, stake, winnerRoll, loserRoll } = result.outcome;
  await interaction.update({
    content:
      `**${winner.name}** [${winnerRoll}] beat **${loser.name}** [${loserRoll}] and takes ${coin(stake)}.`,
    components: [],
  });
}

