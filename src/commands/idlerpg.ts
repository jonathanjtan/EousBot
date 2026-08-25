import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import { config, isAdmin } from "../config.js";
import {
  findByName,
  handOfGod,
  login,
  logout,
  register,
  setAlignment,
} from "../idlerpg/engine.js";
import { characterSheet, itemList, leaderboard, questLine } from "../idlerpg/format.js";
import { renderMap } from "../idlerpg/map.js";
import { duration } from "../idlerpg/rules.js";
import { touch } from "../idlerpg/store.js";
import { context, publish, realm } from "../idlerpg/watch.js";
import type { Alignment, Player } from "../idlerpg/types.js";
import type { Command } from "./types.js";

/**
 * Idle RPG, jotun's game from idlerpg.net, played through slash commands.
 *
 * One command with subcommands rather than a dozen top-level ones: the game
 * has a lot of verbs, and a bot that already owns two dozen commands should
 * not spend twelve more of Discord's allowance on a single feature.
 *
 * Almost everything here is a thin shell over idlerpg/engine.ts. Where a
 * handler looks like it is making a decision, it is deciding what to *show* --
 * the rules never live in this file.
 */

const ALIGNMENTS: Alignment[] = ["good", "neutral", "evil"];

/**
 * Custom IDs for the join panel.
 *
 * Plain constants rather than the encoded scheme in approval.ts, because
 * unlike a PR button these carry no payload: whoever clicked is the whole
 * message, and Discord already tells us who that was.
 */
export const JOIN_BUTTON_ID = "idlerpg:join";
export const JOIN_MODAL_ID = "idlerpg:join-modal";
const CLASS_INPUT_ID = "class";
const NAME_INPUT_ID = "name";

/**
 * A pinnable message with a join button.
 *
 * The point of this is friction. Registering is the one thing standing between
 * a server member and the game, and "run a slash command with a required
 * argument" is a surprisingly effective filter against people ever bothering.
 * A button in a pinned message is one click and a short form.
 */
export function buildJoinPanel() {
  return {
    content: [
      "**Idle RPG**",
      "",
      "You level up by doing nothing. No clicking, no grinding, no way to play well —",
      "time spent registered and quiet is the only thing that advances you. Levelling",
      "finds you an item and picks you a fight; everything else happens *to* you.",
      "",
      "Press the button, name a class, and then forget about it for a month.",
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(JOIN_BUTTON_ID)
          .setLabel("Enter the realm")
          .setEmoji("🗡️")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

export function buildJoinModal(defaultName: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(JOIN_MODAL_ID)
    .setTitle("Enter the realm")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(CLASS_INPUT_ID)
          .setLabel("Your class")
          .setPlaceholder("necromancer, tax auditor, medium-sized dog…")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(40)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(NAME_INPUT_ID)
          .setLabel("Character name")
          .setValue(defaultName.slice(0, 24))
          .setStyle(TextInputStyle.Short)
          .setMaxLength(24)
          .setRequired(false),
      ),
    );
}

/** Shared by the modal and `/idlerpg register`, so both enforce one rule. */
function attemptRegister(userId: string, rawName: string, rawClass: string): string {
  const name = rawName.trim();
  const charClass = rawClass.trim();

  // Names are printed into channel announcements, so anything that could
  // impersonate another member or ping a role is refused rather than escaped.
  if (!/^[\w '\-]{1,24}$/.test(name)) {
    return "Character names are letters, numbers, spaces, apostrophes and hyphens only.";
  }
  if (charClass.length === 0) return "Pick a class. Anything at all; it is pure flavour.";

  const result = register(realm(), userId, name, charClass, context());
  if (!result.ok) return result.reason;
  touch();

  return [
    `**${result.player.name}**, the ${result.player.charClass}, has entered the realm.`,
    `Level 1 in ${duration(result.player.next)} — provided you say nothing.`,
    "",
    "_`/idlerpg help` explains what talking costs you._",
  ].join("\n");
}

export async function handleJoinModal(interaction: ModalSubmitInteraction): Promise<void> {
  const answer = attemptRegister(
    interaction.user.id,
    interaction.fields.getTextInputValue(NAME_INPUT_ID) || interaction.user.username,
    interaction.fields.getTextInputValue(CLASS_INPUT_ID),
  );
  // Ephemeral either way: a refusal is the user's business, and a successful
  // join gets its own channel line from the panel being public already.
  await interaction.reply({ content: answer, flags: MessageFlags.Ephemeral });
}



const HELP = [
  "**Idle RPG** — you level up by doing nothing.",
  "",
  "`/idlerpg register` makes a character, and from that moment your clock runs.",
  "There is no skill, no grinding and nothing to click: time spent logged in and",
  "quiet is the only thing that advances you. Levelling finds you an item and",
  "picks you a fight; the rest happens to you.",
  "",
  "**Not idling costs you.** Every message you send while logged in adds time to",
  "your clock, and the penalty scales steeply with your level — a slip that costs",
  "a beginner seconds costs a veteran hours. Logging out costs more. Abandoning a",
  "quest costs *everyone*.",
  "",
  "**Alignment** is the one real choice. Good fights 10% above its equipment and",
  "is occasionally rewarded in pairs. Evil fights 10% below, lands critical",
  "strikes far more often, and gets to steal from the good — when its god is not",
  "busy punishing it. Neutral does neither.",
  "",
  "**Items** are ten slots, and their sum is your entire combat statistic. Battles",
  "are a roll under that sum, so better equipment tilts a fight without settling",
  "it.",
  "",
  "**Quests** take four players over level 40 and pay a quarter off their clocks.",
  "",
  "`/idlerpg whoami` · `/idlerpg top` · `/idlerpg quest` · `/idlerpg map`",
].join("\n");

/** Resolves a `player` option to a character, or explains why it could not. */
function resolve(name: string | null, userId: string): Player | string {
  const state = realm();
  if (name) {
    const found = findByName(state, name);
    return found ?? `Nobody in the realm is called ${name}.`;
  }
  const mine = state.players[userId];
  return mine ?? "You have no character yet. `/idlerpg register` starts one.";
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("idlerpg")
    .setDescription("Idle RPG — level up by doing absolutely nothing")
    .addSubcommand((s) =>
      s
        .setName("register")
        .setDescription("Create a character and start idling")
        .addStringOption((o) =>
          o
            .setName("class")
            .setDescription("Your class. Anything you like — it is pure flavour")
            .setRequired(true)
            .setMaxLength(40),
        )
        .addStringOption((o) =>
          o
            .setName("name")
            .setDescription("Character name. Defaults to your Discord name")
            .setMaxLength(24),
        ),
    )
    .addSubcommand((s) => s.setName("login").setDescription("Start idling again"))
    .addSubcommand((s) =>
      s.setName("logout").setDescription("Stop idling. This costs you time"),
    )
    .addSubcommand((s) =>
      s
        .setName("align")
        .setDescription("Choose good, neutral or evil")
        .addStringOption((o) =>
          o
            .setName("alignment")
            .setDescription("Good fights better, evil fights dirtier")
            .setRequired(true)
            .addChoices(...ALIGNMENTS.map((a) => ({ name: a, value: a }))),
        ),
    )
    .addSubcommand((s) => s.setName("whoami").setDescription("Your character sheet"))
    .addSubcommand((s) =>
      s
        .setName("status")
        .setDescription("Somebody else's character sheet")
        .addStringOption((o) =>
          o.setName("player").setDescription("Character name").setRequired(true).setMaxLength(24),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("items")
        .setDescription("What a character is carrying")
        .addStringOption((o) =>
          o.setName("player").setDescription("Character name, or blank for yours").setMaxLength(24),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("top")
        .setDescription("The realm, ranked")
        .addIntegerOption((o) =>
          o.setName("count").setDescription("How many to list (default 10)").setMinValue(1).setMaxValue(25),
        ),
    )
    .addSubcommand((s) => s.setName("quest").setDescription("What the current quest is"))
    .addSubcommand((s) => s.setName("map").setDescription("Where everybody is standing"))
    .addSubcommand((s) => s.setName("help").setDescription("How the game works"))
    .addSubcommandGroup((g) =>
      g
        .setName("admin")
        .setDescription("Operator controls")
        .addSubcommand((s) =>
          s
            .setName("hog")
            .setDescription("Summon the hand of God. It is not always merciful")
            .addStringOption((o) =>
              o.setName("player").setDescription("Target, or blank for whoever it lands on").setMaxLength(24),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("panel")
            .setDescription("Post a pinnable join panel with a button"),
        )
        .addSubcommand((s) =>
          s.setName("pause").setDescription("Freeze the world without stopping the bot"),
        )
        .addSubcommand((s) => s.setName("resume").setDescription("Unfreeze the world"))
        .addSubcommand((s) =>
          s
            .setName("adjust")
            .setDescription("Add or remove seconds from a character's clock")
            .addStringOption((o) =>
              o.setName("player").setDescription("Character name").setRequired(true).setMaxLength(24),
            )
            .addIntegerOption((o) =>
              o
                .setName("seconds")
                .setDescription("Negative brings them closer to levelling")
                .setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("delete")
            .setDescription("Remove a character permanently")
            .addStringOption((o) =>
              o.setName("player").setDescription("Character name").setRequired(true).setMaxLength(24),
            ),
        ),
    ),

  async execute(interaction) {
    if (!config.idlerpg.enabled) {
      await interaction.reply({
        content: "Idle RPG is switched off. Set `IDLERPG_ENABLED=true` and restart the bot.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === "admin") {
      // Checked here rather than with `adminOnly` on the command: the rest of
      // /idlerpg is for everyone, and the flag is all-or-nothing.
      if (!isAdmin(interaction.user.id)) {
        await interaction.reply({
          content: "The admin controls are restricted to the bot's admins.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await runAdmin(interaction, sub);
      return;
    }

    switch (sub) {
      case "register":
        return doRegister(interaction);
      case "login":
        return doLogin(interaction);
      case "logout":
        return doLogout(interaction);
      case "align":
        return doAlign(interaction);
      case "whoami":
      case "status":
        return doSheet(interaction, sub === "status");
      case "items":
        return doItems(interaction);
      case "top":
        return doTop(interaction);
      case "quest":
        return doQuest(interaction);
      case "map":
        return doMap(interaction);
      default:
        await interaction.reply({ content: HELP, flags: MessageFlags.Ephemeral });
    }
  },
};

type Interaction = Parameters<Command["execute"]>[0];

async function doRegister(interaction: Interaction): Promise<void> {
  const answer = attemptRegister(
    interaction.user.id,
    interaction.options.getString("name")?.trim() || interaction.user.username,
    interaction.options.getString("class", true),
  );
  await interaction.reply(answer);
}

async function doLogin(interaction: Interaction): Promise<void> {
  const state = realm();
  const player = state.players[interaction.user.id];
  if (!player) {
    await interaction.reply({
      content: "You have no character yet. `/idlerpg register` starts one.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (player.online) {
    await interaction.reply({
      content: `You are already idling. Next level in ${duration(player.next)}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `Welcome back. Next level in ${duration(player.next)}.`,
    flags: MessageFlags.Ephemeral,
  });
  await publish(login(state, interaction.user.id, context()));
}

async function doLogout(interaction: Interaction): Promise<void> {
  const state = realm();
  const player = state.players[interaction.user.id];
  if (!player?.online) {
    await interaction.reply({
      content: "You are not idling.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ content: "Stopping.", flags: MessageFlags.Ephemeral });
  await publish(logout(state, interaction.user.id, context()));
}

async function doAlign(interaction: Interaction): Promise<void> {
  const alignment = interaction.options.getString("alignment", true) as Alignment;
  const state = realm();
  if (!state.players[interaction.user.id]) {
    await interaction.reply({
      content: "You have no character yet. `/idlerpg register` starts one.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ content: `You are now ${alignment}.`, flags: MessageFlags.Ephemeral });
  await publish(setAlignment(state, interaction.user.id, alignment));
}

async function doSheet(interaction: Interaction, other: boolean): Promise<void> {
  const found = resolve(other ? interaction.options.getString("player", true) : null, interaction.user.id);
  if (typeof found === "string") {
    await interaction.reply({ content: found, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({
    embeds: [characterSheet(found, realm(), config.idlerpg.tuning)],
  });
}

async function doItems(interaction: Interaction): Promise<void> {
  const found = resolve(interaction.options.getString("player"), interaction.user.id);
  if (typeof found === "string") {
    await interaction.reply({ content: found, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply(itemList(found));
}

async function doTop(interaction: Interaction): Promise<void> {
  const count = interaction.options.getInteger("count") ?? 10;
  await interaction.reply(leaderboard(realm(), count));
}

async function doQuest(interaction: Interaction): Promise<void> {
  await interaction.reply(questLine(realm(), Date.now()));
}

async function doMap(interaction: Interaction): Promise<void> {
  // Rasterising is fast but not instant, and an interaction has three seconds.
  await interaction.deferReply();
  const png = await renderMap(realm(), config.idlerpg.tuning);
  await interaction.editReply({
    content: questLine(realm(), Date.now()),
    files: [new AttachmentBuilder(png, { name: "realm.png" })],
  });
}

async function runAdmin(interaction: Interaction, sub: string): Promise<void> {
  const state = realm();

  if (sub === "panel") {
    await interaction.reply(buildJoinPanel());
    return;
  }

  if (sub === "pause" || sub === "resume") {
    state.paused = sub === "pause";
    touch();
    await interaction.reply(
      state.paused
        ? "The realm is frozen. Clocks, events and quests are all held."
        : "The realm is running again.",
    );
    return;
  }

  if (sub === "hog") {
    const name = interaction.options.getString("player");
    const target = name ? findByName(state, name) : null;
    if (name && !target) {
      await interaction.reply({
        content: `Nobody in the realm is called ${name}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({ content: "Summoning.", flags: MessageFlags.Ephemeral });
    await publish(handOfGod(state, context(), target ?? undefined));
    return;
  }

  const name = interaction.options.getString("player", true);
  const target = findByName(state, name);
  if (!target) {
    await interaction.reply({
      content: `Nobody in the realm is called ${name}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "adjust") {
    const seconds = interaction.options.getInteger("seconds", true);
    target.next = Math.max(0, target.next + seconds);
    touch();
    await interaction.reply(
      `**${target.name}**'s clock adjusted by ${seconds}s by ${interaction.user.username}. ` +
        `Next level in ${duration(target.next)}.`,
    );
    return;
  }

  if (sub === "delete") {
    delete state.players[target.userId];
    touch();
    await interaction.reply(
      `**${target.name}**, the level ${target.level} ${target.charClass}, is gone. ` +
        `${duration(target.idled)} of idling with them.`,
    );
  }
}
