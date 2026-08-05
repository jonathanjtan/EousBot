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
  decodeCustomId,
} from "./approval.js";
import { commandsByName } from "./commands/index.js";
import { config, isAdmin } from "./config.js";
import { ensureLabels, getFeatureRequest } from "./github.js";
import { currentSha } from "./git.js";
import { log } from "./log.js";
import { acquire, describe, held, release } from "./inflight.js";
import { handleMention } from "./mention.js";
import { revisePullRequest } from "./pipeline.js";
import { syncGuildCommands } from "./register.js";
import { approveAndDeploy, rejectPullRequest } from "./selfdeploy.js";
import { takeInterruptedWork, takePendingAnnouncement } from "./state.js";
import { cachedRevisionRefusal, revisionRefusal } from "./usagegate.js";
import { startUsageResetWatch } from "./usagewatch.js";

/**
 * EousBot: takes feature requests, writes its own code, and redeploys itself
 * behind a human approval gate.
 *
 * Guilds plus GuildMessages, and deliberately NOT MessageContent. Discord
 * delivers full content for messages that mention the app even without that
 * privileged intent, so the conversational handler works while the bot remains
 * unable to read the server's ordinary conversation -- which keeps it out of
 * privileged-intent review and means a stolen token still cannot scrape the
 * channel history.
 */

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

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
      ? `run \`/build ${orphan.target}\` again when you're ready.`
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

    if (interaction.isModalSubmit()) {
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
  if (!client.user || !message.mentions.has(client.user)) return;
  // @everyone / @here sweep in a mention match; only a direct ping counts.
  if (message.mentions.everyone) return;

  try {
    await handleMention(message);
  } catch (err) {
    log.error("Mention handler threw", { err: String(err) });
    await message.reply("Something went wrong handling that. Check my logs.").catch(() => undefined);
  }
});

// A self-restarting bot must exit cleanly, or systemd's restart races the
// gateway's session teardown and Discord reports it perpetually offline.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info(`Received ${signal}, shutting down`);
    client.destroy();
    process.exit(0);
  });
}

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", { reason: String(reason) });
});

await client.login(config.discord.token);
