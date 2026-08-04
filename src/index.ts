import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Interaction,
  type TextChannel,
} from "discord.js";
import { decodeCustomId } from "./approval.js";
import { commandsByName } from "./commands/index.js";
import { config, isAdmin } from "./config.js";
import { ensureLabels, getFeatureRequest } from "./github.js";
import { currentSha } from "./git.js";
import { log } from "./log.js";
import { approveAndDeploy, rejectPullRequest } from "./selfdeploy.js";
import { takePendingAnnouncement } from "./state.js";

/**
 * EousBot: takes feature requests, writes its own code, and redeploys itself
 * behind a human approval gate.
 *
 * Only the Guilds intent is requested. The bot is driven entirely by slash
 * commands and buttons, so it never needs to read message content -- which
 * keeps it out of Discord's privileged-intent review and means a compromised
 * token can't be used to scrape the server's conversations.
 */

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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

  await announcePendingDeploy(sha);
});

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

    if (interaction.isButton()) {
      const target = decodeCustomId(interaction.customId);
      if (!target) return;

      // The allowlist check lives here, not on the message. Discord buttons are
      // clickable by anyone who can see them, so the posted embed is an
      // invitation, never an authorization.
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
