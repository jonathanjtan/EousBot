import { EmbedBuilder, type Message } from "discord.js";
import { buildApprovalMessage } from "./approval.js";
import { isAdmin } from "./config.js";
import * as gh from "./github.js";
import { acquire, describe, release } from "./inflight.js";
import { parseMentionIntent } from "./intent.js";
import { log } from "./log.js";
import { revisePullRequest } from "./pipeline.js";

/**
 * Conversational entry point: talking to the bot instead of driving it.
 *
 * This is a shortcut to the existing gate, never a way around it. A revision
 * runs directly, because it only produces another reviewable PR. Approving and
 * rejecting still go through the buttons -- prose is ambiguous, and a
 * misreading there deploys code nobody agreed to. The confirmation shows what
 * was understood, so a wrong reading is visible before it costs anything.
 *
 * Only messages that @mention the bot reach here, and Discord delivers their
 * content without the privileged MessageContent intent. The bot still cannot
 * read the server's ordinary conversation.
 */

/** Finds the PR a message is about: an explicit number, a reply, or the only one open. */
async function resolveTargetPr(
  message: Message,
  text: string,
): Promise<{ number: number } | { error: string }> {
  // "#11" or "pr 11" wins, since it is unambiguous.
  const explicit = text.match(/#(\d+)|\bpr\s+(\d+)/i);
  if (explicit) {
    const n = Number(explicit[1] ?? explicit[2]);
    if (Number.isInteger(n)) return { number: n };
  }

  // Replying to one of the bot's approval embeds is the natural way to say
  // "this one" when several are open.
  if (message.reference?.messageId) {
    try {
      const referenced = await message.channel.messages.fetch(message.reference.messageId);
      const fromEmbed = referenced.embeds[0]?.title?.match(/PR #(\d+)/);
      if (fromEmbed?.[1]) return { number: Number(fromEmbed[1]) };
      const fromContent = referenced.content.match(/PR #(\d+)/);
      if (fromContent?.[1]) return { number: Number(fromContent[1]) };
    } catch {
      // A deleted or unreachable parent just falls through to the open-PR check.
    }
  }

  const open = await gh.listOpenPullRequests();
  if (open.length === 1 && open[0]) return { number: open[0].number };
  if (open.length === 0) return { error: "There are no open pull requests to act on." };

  return {
    error: [
      `There are ${open.length} open pull requests, so I don't know which you mean.`,
      "Reply to one of my review messages, or name it — e.g. `#" + open[0]?.number + "`.",
      "",
      ...open.map((p) => `• **#${p.number}** — ${p.title}`),
    ].join("\n"),
  };
}

export async function handleMention(message: Message): Promise<void> {
  if (!isAdmin(message.author.id)) {
    await message.reply(
      "Only the bot's admins can direct me. You can still file a request with `/request`.",
    );
    return;
  }

  const intent = parseMentionIntent(message.content);

  if (intent.kind === "help") {
    await message.reply({ embeds: [helpEmbed()] });
    return;
  }

  const text = intent.kind === "revise" ? intent.feedback : intent.kind === "reject" ? intent.reason : "";
  const target = await resolveTargetPr(message, text || message.content);

  if ("error" in target) {
    await message.reply(target.error);
    return;
  }

  if (intent.kind === "approve" || intent.kind === "reject") {
    // Re-post the real gate rather than acting on prose. One click, and the
    // embed states plainly which PR and which action were understood.
    const pr = await gh.getPullRequest(target.number).catch(() => null);
    if (!pr || pr.state !== "open") {
      await message.reply(`PR **#${target.number}** isn't open, so there's nothing to act on.`);
      return;
    }

    await message.reply({
      content:
        intent.kind === "approve"
          ? `I read that as **approve and deploy PR #${target.number}**. Confirm below — approving merges and restarts the bot.`
          : `I read that as **reject PR #${target.number}**. Confirm below.`,
      ...buildApprovalMessage({
        prNumber: pr.number,
        prUrl: pr.html_url,
        issueNumber: Number(pr.body?.match(/Closes #(\d+)/)?.[1] ?? 0),
        title: pr.title,
        summary: pr.body?.split("\n---")[0]?.slice(0, 1200) ?? "",
        diffStat: "",
        costUsd: null,
        requestedBy: message.author.id,
      }),
    });
    return;
  }

  // Revisions run directly: the output is another reviewable PR, so the
  // existing gate still stands between this and anything shipping.
  await runRevision(message, target.number, intent.feedback);
}

async function runRevision(message: Message, prNumber: number, feedback: string): Promise<void> {
  const lock = acquire({
    kind: "revise",
    target: prNumber,
    startedBy: message.author.username,
    channelId: message.channelId,
    at: new Date().toISOString(),
  });
  if (!lock.ok) {
    await message.reply(`${describe(lock.held)} is already running. Give me a minute.`);
    return;
  }

  const status = await message.reply(`On it — revising **PR #${prNumber}**…`);

  let latest = "Starting…";
  let dirty = false;
  const flush = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    status.edit(`Revising **PR #${prNumber}**\n\`${latest}\``).catch(() => undefined);
  }, 4000);

  try {
    const outcome = await revisePullRequest(
      { prNumber, feedback, requestedBy: message.author.username },
      (stage, detail) => {
        latest = detail ? `${stage}: ${detail.replace(/\s+/g, " ").slice(0, 120)}` : stage;
        dirty = true;
      },
    );
    clearInterval(flush);

    switch (outcome.kind) {
      case "revised":
        // Reply to the status message rather than the channel: `send` is not
        // available on every channel type a message can arrive in, and a reply
        // also keeps the revision attached to the request that caused it.
        await status.edit(`**PR #${outcome.prNumber} revised.**`);
        await status.reply(
          buildApprovalMessage({
            prNumber: outcome.prNumber,
            prUrl: outcome.prUrl,
            issueNumber: 0,
            title: `Revision of PR #${outcome.prNumber}`,
            summary: outcome.summary,
            diffStat: outcome.diffStat,
            costUsd: outcome.costUsd,
            requestedBy: message.author.id,
          }),
        );
        break;
      case "no-changes":
        await status.edit(
          `I read the feedback but didn't change anything.\n\n${outcome.summary.slice(0, 800)}`,
        );
        break;
      case "failed":
        await status.edit(
          [
            `Revision failed at \`${outcome.stage}\`. PR #${prNumber} is untouched.`,
            "```",
            outcome.detail.slice(0, 1200),
            "```",
          ].join("\n"),
        );
        break;
    }
  } catch (err) {
    clearInterval(flush);
    log.error("Mention revision threw", { pr: prNumber, err: String(err) });
    await status.edit(`That crashed:\n\`\`\`\n${String(err).slice(0, 1200)}\n\`\`\``).catch(() => undefined);
  } finally {
    clearInterval(flush);
    release();
  }
}

function helpEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x1d76db)
    .setTitle("Talking to me")
    .setDescription(
      [
        "Mention me with what you want and I'll work it out:",
        "",
        "• **“do X instead”** / **“drop the polling, use a command”** — I revise the PR",
        "• **“looks good, ship it”** — I'll ask you to confirm, then deploy",
        "• **“reject that”** — I'll ask you to confirm, then close it",
        "",
        "I'll use the only open PR, or the one you reply to, or name it like `#11`.",
        "",
        "Anything ambiguous I treat as feedback rather than approval, since that's",
        "the reversible one. Approving and rejecting always want a button.",
      ].join("\n"),
    )
    .setFooter({ text: "The slash commands all still work: /build /revise /status" });
}
