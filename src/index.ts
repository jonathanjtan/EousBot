import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Interaction,
  type TextChannel,
} from "discord.js";
import {
  FEEDBACK_INPUT_ID,
  buildApprovalMessage,
  buildRevisionModal,
  closeApprovalButtons,
  decodeAskCustomId,
  decodeCustomId,
} from "./approval.js";
import { handleAskModal } from "./commands/ask.js";
import { commandsByName, messageCommandsByName } from "./commands/index.js";
import {
  JOIN_BUTTON_ID,
  JOIN_MODAL_ID,
  buildJoinModal,
  handleJoinModal,
} from "./commands/idlerpg.js";
import { config, isAdmin } from "./config.js";
import { ensureLabels, getFeatureRequest } from "./github.js";
import { currentSha } from "./git.js";
import { log } from "./log.js";
import { acquire, describe, held, release } from "./inflight.js";
import { penalizeMessage, penalizeNick, penalizePart } from "./idlerpg/engine.js";
import {
  context as idlerpgContext,
  inPenaltyScope,
  isPresent,
  notePresence,
  presenceDriven,
  publish,
  realm,
  saveNow,
  startIdleRpg,
  syncAllPresence,
} from "./idlerpg/watch.js";
import { handleMention } from "./mention.js";
import { revisePullRequest } from "./pipeline.js";
import { syncGuildCommands } from "./register.js";
import { startFeedWatch } from "./feedwatch.js";
import { approveAndDeploy, rejectPullRequest } from "./selfdeploy.js";
import { takeInterruptedWork, takePendingAnnouncement } from "./state.js";
import { cachedRevisionRefusal, revisionRefusal } from "./usagegate.js";
import { startUsageResetWatch } from "./usagewatch.js";

/**
 * EousBot: takes feature requests, writes its own code, and redeploys itself
 * behind a human approval gate.
 *
 * Guilds plus GuildMessages, and by default NOT MessageContent. Discord
 * delivers full content for messages that mention the app even without that
 * privileged intent, so the conversational handler works while the bot remains
 * unable to read the server's ordinary conversation -- which keeps it out of
 * privileged-intent review and means a stolen token still cannot scrape the
 * channel history.
 *
 * The cost of that choice is real and worth naming: any message that does not
 * mention the bot arrives with `content` and `attachments` emptied, over the
 * HTTP API as much as the gateway. Replying to someone's post and mentioning
 * the bot therefore hands it your reply and nothing else. Pointing it at
 * another message needs the context menu command in commands/ask.ts, which
 * Discord exempts by name.
 *
 * DISCORD_PRIVILEGED_INTENTS can switch that off, and everything in the
 * paragraph above stops being true when it does. It exists because Idle RPG
 * wants inputs IRC gave it for nothing -- see `intents()` below for which and
 * why -- and it is a per-server judgement, not a default. A server that turns
 * on `messagecontent` has decided this process may read its conversation, and
 * should be told so rather than discovering it in a commit.
 */

/**
 * The gateway intents, assembled from config.
 *
 * Guilds and GuildMessages are unconditional and unprivileged. The other three
 * are privileged, off by default, and each buys back a specific thing IRC gave
 * Idle RPG for free:
 *
 *   MessageContent - a message's length, so talking is billed the way upstream
 *                    bills an IRC line instead of at a flat rate
 *   GuildPresences - who is actually connected, so nobody types /login
 *   GuildMembers   - leaving the server and renaming yourself, the last two of
 *                    upstream's five penalties
 *
 * They are not free. MessageContent in particular means this process, and
 * anyone holding its token, can read the server's ordinary conversation --
 * which the bot was deliberately built not to do. Enabling it is a judgement
 * about a specific server, not a default, which is why it lives in config and
 * starts empty.
 */
function intents(): GatewayIntentBits[] {
  const wanted = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  const privileged = config.discord.privilegedIntents;
  if (privileged.messageContent) wanted.push(GatewayIntentBits.MessageContent);
  if (privileged.presence) wanted.push(GatewayIntentBits.GuildPresences);
  if (privileged.members) wanted.push(GatewayIntentBits.GuildMembers);
  return wanted;
}

const client = new Client({ intents: intents() });

/** Serializes deploys the same way builds are serialized, for the same reason. */
let deployInFlight = false;


client.once(Events.ClientReady, async (ready) => {
  const sha = await currentSha().catch(() => "unknown");
  log.info(`Logged in as ${ready.user.tag}`, {
    sha: sha.slice(0, 8),
    authMode: config.agent.authMode,
    admins: config.discord.adminIds.size,
  });

  await ensureLabels().catch((err) =>
    log.warn("Could not ensure GitHub labels", { err: String(err) }),
  );

  // Closes the self-modification loop. A command the agent wrote is compiled
  // and loaded by the restart above, but Discord serves its command list from
  // a cached schema -- so without this, every new command needed a human to
  // run a script before anyone could invoke it.
  await syncGuildCommands(ready.rest).catch((err) =>
    log.error("Could not sync slash commands", { err: String(err) }),
  );

  startUsageResetWatch(client);
  // Resumes the drop-feed relay behind /restock. No-op unless
  // TARGET_RESTOCK_ENABLED is set.
  startFeedWatch(client);
  // Starts the Idle RPG clock. No-op unless IDLERPG_ENABLED is set.
  startIdleRpg(client);
  if (config.idlerpg.enabled) {
    const guild = client.guilds.cache.get(config.discord.guildId);
    if (guild) {
      await syncAllPresence(guild).catch((err) =>
        log.warn("Idle RPG presence sync failed", { err: String(err) }),
      );
    }
  }

  await announcePendingDeploy(sha);
  await reportInterruptedWork();
});

/**
 * Reports work that a restart killed.
 *
 * A claim still on disk means the previous process died mid-run -- almost
 * always a deploy restarting the service. Without this the Discord message
 * simply stops updating and looks indistinguishable from a slow build, which
 * is exactly how a killed revision reads as a hung one.
 */
async function reportInterruptedWork(): Promise<void> {
  const orphan = takeInterruptedWork();
  if (!orphan) return;

  log.warn("Previous process died mid-run", { orphan });

  const what =
    orphan.kind === "build"
      ? `build of request #${orphan.target}`
      : `revision of PR #${orphan.target}`;

  const text = [
    `**A ${what} was interrupted** by a restart and did not finish.`,
    `Started by ${orphan.startedBy} at ${orphan.at}. Nothing was pushed, so nothing is half-done —`,
    orphan.kind === "build"
      ? `run \`/claude ${orphan.target}\` again when you're ready.`
      : `run \`/revise pr:${orphan.target}\` again when you're ready.`,
  ].join("\n");

  try {
    const channel = await client.channels.fetch(orphan.channelId ?? config.discord.channelId);
    if (channel?.isTextBased() && "send" in channel) {
      await (channel as TextChannel).send(text);
    }
  } catch (err) {
    log.warn("Could not report interrupted work", { err: String(err) });
  }
}

/**
 * If the last thing this process's predecessor did was deploy and restart,
 * deliver the message it couldn't send before exiting.
 */
async function announcePendingDeploy(sha: string): Promise<void> {
  const pending = takePendingAnnouncement();
  if (!pending) return;

  const landed = sha.startsWith(pending.expectedSha.slice(0, 8));
  const text = landed
    ? [
        `**Deployed.** PR #${pending.prNumber} — ${pending.title}`,
        `Approved by ${pending.approvedBy}. Now running \`${sha.slice(0, 8)}\`.`,
      ].join("\n")
    : [
        `**Restarted, but the commit doesn't match.** PR #${pending.prNumber} — ${pending.title}`,
        `Expected \`${pending.expectedSha.slice(0, 8)}\`, running \`${sha.slice(0, 8)}\`.`,
        `Something else moved the checkout — worth a look.`,
      ].join("\n");

  try {
    const channel = await client.channels.fetch(pending.channelId);
    if (channel?.isTextBased() && "send" in channel) {
      await (channel as TextChannel).send(text);
    }
  } catch (err) {
    log.warn("Could not deliver post-restart announcement", { err: String(err) });
  }
}

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commandsByName.get(interaction.commandName);
      if (!command) {
        log.warn("Unknown command", { name: interaction.commandName });
        return;
      }

      if (command.adminOnly && !isAdmin(interaction.user.id)) {
        await interaction.reply({
          content: "That command is restricted to the bot's admins.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await command.execute(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      // Discord gives autocomplete three seconds and shows nothing if the
      // window closes, so handlers answer from memory rather than the network.
      const command = commandsByName.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
      return;
    }

    // The "Apps" entry on a right-clicked message. Routed apart from slash
    // commands because Discord delivers it as its own interaction type, with
    // the target message attached -- see commands/ask.ts for why that matters.
    if (interaction.isMessageContextMenuCommand()) {
      const command = messageCommandsByName.get(interaction.commandName);
      if (!command) {
        log.warn("Unknown message command", { name: interaction.commandName });
        return;
      }

      if (command.adminOnly && !isAdmin(interaction.user.id)) {
        await interaction.reply({
          content: "That command is restricted to the bot's admins.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await command.execute(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      // Idle RPG first: its IDs carry no payload and would decode to null in
      // either of the codecs below, which return early rather than fall through.
      if (interaction.customId === JOIN_MODAL_ID) {
        await handleJoinModal(interaction);
        return;
      }

      // Checked before the approval codec: the two use different prefixes, and
      // `decodeCustomId` returning null for one of ours would silently drop it.
      const askKey = decodeAskCustomId(interaction.customId);
      if (askKey) {
        await handleAskModal(interaction, askKey);
        return;
      }

      const target = decodeCustomId(interaction.customId);
      if (!target || target.action !== "revise") return;

      const feedback = interaction.fields.getTextInputValue(FEEDBACK_INPUT_ID).trim();
      if (!feedback) {
        await interaction.reply({
          content: "No feedback given, so nothing to revise.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply();

      // The binding usage check, re-made here rather than trusted from the
      // button that opened the modal: the modal carries its own interaction
      // and its own user. Reading live figures takes longer than the three
      // seconds an interaction has to be answered in, so it comes after the
      // defer -- and before the lock, so a refused request never holds one.
      const refusal = await revisionRefusal(interaction.user.id);
      if (refusal) {
        await interaction.editReply(refusal);
        return;
      }

      const lock = acquire({
        kind: "revise",
        target: target.prNumber,
        startedBy: interaction.user.username,
        channelId: interaction.channelId,
        at: new Date().toISOString(),
      });
      if (!lock.ok) {
        await interaction.editReply(
          `${describe(lock.held)} is already running. Wait for it to finish.`,
        );
        return;
      }

      // Only now that the revision is definitely running: a refused or
      // blocked request leaves the prompt approvable, because nothing changed.
      // interaction.message is null when the modal came from /revise, which
      // closeApprovalButtons handles.
      await closeApprovalButtons(interaction.message, interaction.user.username);

      let latest = "Starting…";
      let dirty = false;
      const flush = setInterval(() => {
        if (!dirty) return;
        dirty = false;
        interaction
          .editReply(`**Revising PR #${target.prNumber}**\n\`${latest}\``)
          .catch(() => undefined);
      }, 4000);

      try {
        const outcome = await revisePullRequest(
          {
            prNumber: target.prNumber,
            feedback,
            requestedBy: interaction.user.username,
          },
          (stage, detail) => {
            latest = detail ? `${stage}: ${detail.replace(/\s+/g, " ").slice(0, 120)}` : stage;
            dirty = true;
          },
        );
        clearInterval(flush);

        switch (outcome.kind) {
          case "revised": {
            await interaction.editReply(
              [
                `**PR #${outcome.prNumber} revised.** (round ${outcome.round})`,
                `> ${feedback.split("\n")[0]?.slice(0, 200)}`,
                ...(outcome.round >= 3
                  ? [
                      "",
                      `_Round ${outcome.round} — each round re-reads the whole accumulated session, so these get steeper. If it's still not right, rejecting and rebuilding from a sharper request is often cheaper than another round._`,
                    ]
                  : []),
              ].join("\n"),
            );
            // A fresh approval prompt, so the revision gets the same gate the
            // original did rather than inheriting its approval.
            await interaction.followUp(
              buildApprovalMessage({
                prNumber: outcome.prNumber,
                prUrl: outcome.prUrl,
                issueNumber: target.issueNumber ?? 0,
                title: `Revision of PR #${outcome.prNumber}`,
                summary: outcome.summary,
                diffStat: outcome.diffStat,
                costUsd: outcome.costUsd,
                requestedBy: interaction.user.id,
              }),
            );
            break;
          }
          case "no-changes":
            await interaction.editReply(
              `**PR #${target.prNumber} unchanged** — the agent read the feedback but made no edit.\n\n${outcome.summary.slice(0, 1000)}`,
            );
            break;
          case "failed":
            await interaction.editReply(
              [
                `**Revision failed** at \`${outcome.stage}\`. PR #${target.prNumber} is untouched and still reviewable.`,
                "```",
                outcome.detail.slice(0, 1400),
                "```",
              ].join("\n"),
            );
            break;
        }
      } catch (err) {
        clearInterval(flush);
        log.error("Revision threw", { pr: target.prNumber, err: String(err) });
        await interaction
          .editReply(`Revision crashed:\n\`\`\`\n${String(err).slice(0, 1400)}\n\`\`\``)
          .catch(() => undefined);
      } finally {
        clearInterval(flush);
        release();
      }
      return;
    }

    if (interaction.isButton()) {
      // The join panel is open to everyone in the guild by design -- it is the
      // whole point of the panel. Nothing it can do is privileged: it creates a
      // character for whoever pressed it and can create no other.
      if (interaction.customId === JOIN_BUTTON_ID) {
        if (!config.idlerpg.enabled) {
          await interaction.reply({
            content: "Idle RPG is switched off.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        // showModal must be the first response to an interaction; it cannot
        // follow a defer or a reply.
        await interaction.showModal(
          buildJoinModal(interaction.member?.user.username ?? interaction.user.username),
        );
        return;
      }

      const target = decodeCustomId(interaction.customId);
      if (!target) return;

      // Requesting changes is open to everyone; what stands in for the
      // allowlist there is the usage gate, checked properly on submit.
      if (target.action === "revise") {
        const busy = held();
        if (busy) {
          await interaction.reply({
            content: `${describe(busy)} is already running. Wait for it to finish.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const refusal = cachedRevisionRefusal(interaction.user.id);
        if (refusal) {
          await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
          return;
        }
        // showModal must be the *first* response to the interaction -- it
        // cannot follow a defer or a reply. The lock is taken on submit, not
        // here: holding it across a modal the user might never submit would
        // wedge every other entry point.
        await interaction.showModal(buildRevisionModal(target.prNumber, target.issueNumber));
        return;
      }

      // Deploying and rejecting stay with the admins. The allowlist check
      // lives here, not on the message: Discord buttons are clickable by
      // anyone who can see them, so the posted embed is an invitation, never
      // an authorization.
      if (!isAdmin(interaction.user.id)) {
        await interaction.reply({
          content: "Only the bot's admins can approve or reject a deploy.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (target.action === "reject") {
        await interaction.deferUpdate();
        await rejectPullRequest({
          prNumber: target.prNumber,
          issueNumber: target.issueNumber,
          rejectedByName: interaction.user.username,
        });
        await interaction.editReply({
          content: `Rejected by ${interaction.user.username}. PR #${target.prNumber} closed; nothing was deployed.`,
          components: [],
        });
        return;
      }

      if (deployInFlight) {
        await interaction.reply({
          content: "A deploy is already running. Wait for it to finish.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      deployInFlight = true;
      await interaction.deferUpdate();
      // Strip the buttons immediately so a double-click can't queue a second merge.
      await interaction.editReply({
        content: `Approved by ${interaction.user.username}. Deploying…`,
        components: [],
      });

      try {
        const request =
          target.issueNumber !== null ? await getFeatureRequest(target.issueNumber) : null;

        const outcome = await approveAndDeploy({
          prNumber: target.prNumber,
          issueNumber: target.issueNumber,
          title: request?.title ?? `PR #${target.prNumber}`,
          approvedBy: interaction.user.id,
          approvedByName: interaction.user.username,
          channelId: interaction.channelId,
          onProgress: (stage) => {
            interaction
              .editReply({
                content: `Approved by ${interaction.user.username}. \`${stage}\`…`,
                components: [],
              })
              .catch(() => undefined);
          },
        });

        switch (outcome.kind) {
          case "restarting":
            // The confirmation comes from the *next* process, after restart.
            await interaction.editReply({
              content: `Merged \`${outcome.sha.slice(0, 8)}\` and restarting. Back shortly.`,
              components: [],
            });
            break;
          case "deployed-no-restart":
            await interaction.editReply({
              content: `Merged and built \`${outcome.sha.slice(0, 8)}\`. No systemd unit configured, so restart manually to pick it up.`,
              components: [],
            });
            break;
          case "failed":
            await interaction.editReply({
              content: [
                `Deploy failed at \`${outcome.stage}\`:`,
                "```",
                outcome.detail.slice(0, 1500),
                "```",
              ].join("\n"),
              components: [],
            });
            break;
        }
      } finally {
        deployInFlight = false;
      }
    }
  } catch (err) {
    log.error("Interaction handler threw", { err: String(err) });
    if (interaction.isRepliable()) {
      const content = "Something went wrong handling that. Check the bot's logs.";
      await (interaction.deferred || interaction.replied
        ? interaction.followUp({ content, flags: MessageFlags.Ephemeral })
        : interaction.reply({ content, flags: MessageFlags.Ephemeral })
      ).catch(() => undefined);
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore other bots (and ourselves) unconditionally: a bot that answers bots
  // can be walked into a loop by anything that echoes mentions.
  if (message.author.bot) return;

  // Idle RPG's only input. Deliberately ahead of the mention check: the game
  // is about *not* talking, so it has to see every message, and it is the one
  // thing here that works without the Message Content intent -- the bot needs
  // to know that somebody spoke, never what they said.
  if (
    config.idlerpg.enabled &&
    message.guildId === config.discord.guildId &&
    inPenaltyScope(message.channelId)
  ) {
    try {
      // Zero without the MessageContent intent, which penalizeMessage reads as
      // "unknown" and bills at the flat rate rather than as a free message.
      await publish(
        penalizeMessage(realm(), message.author.id, idlerpgContext(), message.content.length),
      );
    } catch (err) {
      log.warn("Idle RPG penalty failed", { err: String(err) });
    }
  }

  // `ignoreRepliedUser` is the whole point: replying to the bot pings it, and
  // without this every reply to one of its answers reads as a fresh question.
  // Continuing a conversation should take an explicit @, same as starting one.
  if (!client.user || !message.mentions.has(client.user, { ignoreRepliedUser: true })) return;
  // @everyone / @here sweep in a mention match; only a direct ping counts.
  if (message.mentions.everyone) return;

  try {
    await handleMention(message);
  } catch (err) {
    log.error("Mention handler threw", { err: String(err) });
    await message.reply("Something went wrong handling that. Check my logs.").catch(() => undefined);
  }
});

/**
 * Idle RPG's remaining inputs, all of which need a privileged intent and all of
 * which are inert without one.
 *
 * Registered as unconditionally as the message hook is: each handler checks
 * whether the game wants it, rather than the wiring guessing at boot.
 */
client.on(Events.PresenceUpdate, (_old, presence) => {
  if (!config.idlerpg.enabled || !presenceDriven()) return;
  if (presence.guild?.id !== config.discord.guildId) return;
  if (presence.user?.bot) return;
  try {
    notePresence(presence.userId, isPresent(presence.status));
  } catch (err) {
    log.warn("Idle RPG presence update failed", { err: String(err) });
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  if (!config.idlerpg.enabled || member.guild.id !== config.discord.guildId) return;
  if (member.user.bot) return;
  try {
    await publish(penalizePart(realm(), member.id, idlerpgContext()));
  } catch (err) {
    log.warn("Idle RPG part penalty failed", { err: String(err) });
  }
});

client.on(Events.GuildMemberUpdate, async (before, after) => {
  if (!config.idlerpg.enabled || after.guild.id !== config.discord.guildId) return;
  if (after.user.bot) return;
  // GuildMemberUpdate fires for role changes, timeouts and avatar edits too.
  // Only a rename is a penalty, so everything else must fall through silently.
  if (before.nickname === after.nickname) return;
  try {
    await publish(penalizeNick(realm(), after.id, idlerpgContext()));
  } catch (err) {
    log.warn("Idle RPG nick penalty failed", { err: String(err) });
  }
});

// A self-restarting bot must exit cleanly, or systemd's restart races the
// gateway's session teardown and Discord reports it perpetually offline.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info(`Received ${signal}, shutting down`);
    // The realm is flushed on a timer, so an unannounced restart would
    // otherwise roll every player back to the last save.
    saveNow();
    client.destroy();
    process.exit(0);
  });
}

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", { reason: String(reason) });
});

await client.login(config.discord.token);
