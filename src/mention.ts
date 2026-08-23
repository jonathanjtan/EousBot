import { EmbedBuilder, type Message } from "discord.js";
import { buildApprovalMessage } from "./approval.js";
import { answer, downloadImages, imagesFrom, releaseWorkspace, splitForDiscord } from "./chat.js";
import { config, isAdmin } from "./config.js";
import * as gh from "./github.js";
import { acquire, describe, release } from "./inflight.js";
import { parseMentionIntent } from "./intent.js";
import { log } from "./log.js";
import { buildFeature, revisePullRequest } from "./pipeline.js";
import type { OutputFile } from "./chat.js";

/**
 * Conversational entry point: talking to the bot instead of driving it.
 *
 * This is a shortcut to the existing gate, never a way around it. Builds and
 * revisions run directly, because they only produce a reviewable PR. Approving and
 * rejecting still go through the buttons -- prose is ambiguous, and a
 * misreading there deploys code nobody agreed to. The confirmation shows what
 * was understood, so a wrong reading is visible before it costs anything.
 *
 * A mention that is simply a question goes to chat.ts instead, which touches
 * neither the repository nor GitHub. That path is still admin-only, for the
 * reason in README.md: in hostAuth mode every answer is billed against the
 * host account's Claude login, and an allowlist is the only thing bounding
 * who can spend it. Opening it to the guild wants a real API key first.
 *
 * Only messages that @mention the bot reach here, and Discord delivers their
 * content without the privileged MessageContent intent. The bot still cannot
 * read the server's ordinary conversation.
 */

/**
 * The message this one replies to, or null.
 *
 * Fetched once per mention and passed down, because two things now need it:
 * resolving which PR feedback is about, and telling the parser that a message
 * is part of a review thread at all. A deleted or unreachable parent is not an
 * error -- both callers have a sensible answer without one.
 */
async function fetchReplyParent(message: Message): Promise<Message | null> {
  if (!message.reference?.messageId) return null;
  try {
    return await message.channel.messages.fetch(message.reference.messageId);
  } catch {
    return null;
  }
}

/**
 * The PR a message of the bot's is about, if it is a review message at all.
 *
 * "A reply to the bot" is not the same as "a reply about a pull request", and
 * conflating them routed chat follow-ups -- replying to an answer to ask
 * another question -- straight into the revision path. Only a message naming a
 * PR counts as review context.
 */
function reviewedPrNumber(message: Message | null): number | null {
  if (!message) return null;
  const fromEmbed = message.embeds[0]?.title?.match(/PR #(\d+)/);
  if (fromEmbed?.[1]) return Number(fromEmbed[1]);
  const fromContent = message.content.match(/PR #(\d+)/);
  if (fromContent?.[1]) return Number(fromContent[1]);
  return null;
}

/** Finds the PR a message is about: an explicit number, a reply, or the only one open. */
async function resolveTargetPr(
  message: Message,
  reviewPr: number | null,
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
  if (reviewPr !== null) return { number: reviewPr };

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
      "Only the bot's admins can direct me. You can still file a request with `/request`, " +
        "or ask for changes to an open PR with `/revise`.",
    );
    return;
  }

  const replyParent = await fetchReplyParent(message);
  const reviewPr =
    replyParent?.author.id === message.client.user.id ? reviewedPrNumber(replyParent) : null;

  const intent = parseMentionIntent(message.content, {
    // Only a reply to a *review* message counts. Replying to one of the bot's
    // answers is how a conversation continues, not how a PR gets revised.
    replyingToReview: reviewPr !== null,
    hasImage: imagesFrom(message.attachments.values()).length > 0,
  });

  if (intent.kind === "help") {
    await message.reply({ embeds: [helpEmbed()] });
    return;
  }

  // Answering costs a reply and nothing else, so it neither takes the inflight
  // lock nor waits for one -- a question during a build is still just a question.
  if (intent.kind === "chat") {
    await runChat(message, intent.text);
    return;
  }

  // A build produces a pull request and nothing else, so it runs directly for
  // the same reason a revision does.
  if (intent.kind === "build") {
    await runBuild(message, intent.issueNumber);
    return;
  }

  const text = intent.kind === "revise" ? intent.feedback : intent.kind === "reject" ? intent.reason : "";
  const target = await resolveTargetPr(message, reviewPr, text || message.content);

  if ("error" in target) {
    // A revision with no pull request to revise is not an error, it is a
    // misread: the parser saw PR-ish wording where the user meant a request.
    // Answering is both more useful and cheaper than refusing. Approving and
    // rejecting still refuse, since neither means anything without a PR.
    if (intent.kind === "revise") {
      await runChat(message, intent.feedback);
      return;
    }
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

/** Agent-produced files, in the shape discord.js wants for an upload. */
function attachments(files: OutputFile[]) {
  return files.map((f) => ({ attachment: f.path, name: f.name }));
}

/**
 * One question in flight per person.
 *
 * Not the inflight lock -- that one serialises the whole bot, and a chat has
 * no reason to block a build or be blocked by one. This is narrower: it stops
 * an impatient double-ping from paying for the same answer twice, and stops a
 * mention loop with another bot from opening runs without limit.
 */
const chatting = new Set<string>();

async function runChat(message: Message, text: string): Promise<void> {
  if (!config.chat.enabled) {
    await message.reply(
      "I'm not set up to answer questions — `CHAT_ENABLED` is off. " +
        "`/claude`, `/revise` and `/status` still work.",
    );
    return;
  }

  if (chatting.has(message.author.id)) {
    await message.reply("Still working on your last one — give me a second.");
    return;
  }
  chatting.add(message.author.id);

  // The typing indicator rather than a placeholder message: an answer takes
  // seconds, and a "thinking…" message that gets edited afterwards reads worse
  // than the signal Discord already has for exactly this. It expires after
  // ten seconds, hence the refresh.
  const type = () => {
    if ("sendTyping" in message.channel) message.channel.sendTyping().catch(() => undefined);
  };
  type();
  const typing = setInterval(type, 8000);

  try {
    const { images, skipped } = await downloadImages(imagesFrom(message.attachments.values()));
    const result = await answer({
      text,
      images,
      askedBy: message.author.username,
      // The channel is the conversation: a follow-up resumes the same session
      // and finds the same workspace, so "now crop it" means something.
      conversation: message.channelId,
    });
    clearInterval(typing);

    if (!result.ok) {
      await message.reply(
        result.error === "STOPPED"
          ? "Stopped."
          : `I couldn't answer that — ${result.error.slice(0, 400)}`,
      );
      return;
    }

    // Skips are appended rather than sent first: the answer is what was asked
    // for, and "I ignored your HEIC" is a footnote to it.
    const note = skipped.length > 0 ? `\n\n-# Couldn't read: ${skipped.join(", ")}` : "";
    const chunks = splitForDiscord((result.reply || "Done.") + note);

    let last = message;
    for (const [i, chunk] of chunks.entries()) {
      // Files ride on the final message so the prose arrives first.
      const attach = i === chunks.length - 1 ? attachments(result.files) : undefined;
      last = await last.reply(attach?.length ? { content: chunk, files: attach } : chunk);
    }
    if (result.ephemeral) await releaseWorkspace(result.workspace);
  } catch (err) {
    clearInterval(typing);
    log.error("Chat handler threw", { err: String(err) });
    await message.reply("That question broke something. Check my logs.").catch(() => undefined);
  } finally {
    clearInterval(typing);
    chatting.delete(message.author.id);
  }
}

async function runBuild(message: Message, issueNumber: number): Promise<void> {
  const request = await gh.getFeatureRequest(issueNumber);
  if (!request) {
    await message.reply(
      `No feature request numbered **#${issueNumber}** — that number might be a PR. Check \`/status\`.`,
    );
    return;
  }

  const lock = acquire({
    kind: "build",
    target: issueNumber,
    startedBy: message.author.username,
    channelId: message.channelId,
    at: new Date().toISOString(),
  });
  if (!lock.ok) {
    await message.reply(`${describe(lock.held)} is already running. Give me a minute.`);
    return;
  }

  const header = `**Building #${issueNumber}** — ${request.title}`;
  const status = await message.reply(`${header}\n\`Starting…\``);

  let latest = "Starting…";
  let dirty = false;
  const flush = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    status.edit(`${header}\n\`${latest}\``).catch(() => undefined);
  }, 4000);

  try {
    // No model or effort override: prose isn't a good place to pick one, and
    // `/claude` is still there for a request that warrants more.
    const outcome = await buildFeature(request, (stage, detail) => {
      latest = detail ? `${stage}: ${detail.replace(/\s+/g, " ").slice(0, 120)}` : stage;
      dirty = true;
    });
    clearInterval(flush);

    switch (outcome.kind) {
      case "opened":
        await status.edit(`**#${issueNumber}** built successfully — review below.`);
        await status.reply(
          buildApprovalMessage({
            prNumber: outcome.prNumber,
            prUrl: outcome.prUrl,
            issueNumber,
            title: request.title,
            summary: outcome.summary,
            diffStat: outcome.diffStat,
            costUsd: outcome.costUsd,
            requestedBy: request.requestedBy,
          }),
        );
        break;
      case "no-changes":
        await status.edit(
          `**#${issueNumber}**: the agent finished but changed nothing. Its notes are on the issue.`,
        );
        break;
      case "failed":
        await status.edit(
          [
            `**#${issueNumber}** failed at \`${outcome.stage}\`. No pull request was opened.`,
            "```",
            outcome.detail.slice(0, 1200),
            "```",
          ].join("\n"),
        );
        break;
    }
  } catch (err) {
    clearInterval(flush);
    log.error("Mention build threw", { issue: issueNumber, err: String(err) });
    await status
      .edit(`That crashed:\n\`\`\`\n${String(err).slice(0, 1200)}\n\`\`\``)
      .catch(() => undefined);
  } finally {
    clearInterval(flush);
    release();
  }
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
        await status.edit(
          `**PR #${outcome.prNumber} revised.** (round ${outcome.round})` +
            (outcome.round >= 3
              ? `\n_Each round re-reads the whole session, so these get steeper — a rebuild from a sharper request may be cheaper than another round._`
              : ""),
        );
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
        "• **“work on #16”** / **“build issue 12”** — I write the code and open a PR",
        "• **“do X instead”** / **“drop the polling, use a command”** — I revise the PR",
        "• **“looks good, ship it”** — I'll ask you to confirm, then deploy",
        "• **“reject that”** — I'll ask you to confirm, then close it",
        "• **anything else** — “fetch the latest /vt/ threads”, “make these a collage”,",
        "  “what's the weather in Osaka?”, a photo — I just do it",
        "",
        "**Anything that isn't clearly about a PR is a request I'll act on.** To give",
        "feedback instead, reply to my review message or name it like `#11` — that's",
        "what tells me a pull request is involved. Approving and rejecting always",
        "want a button.",
      ].join("\n"),
    )
    .setFooter({ text: "The slash commands all still work: /claude /revise /status" });
}
