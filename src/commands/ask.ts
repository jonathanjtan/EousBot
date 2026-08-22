import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  MessageFlags,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { QUESTION_INPUT_ID, buildAskModal } from "../approval.js";
import { answer, downloadImages, imagesFrom, splitForDiscord } from "../chat.js";
import { config } from "../config.js";
import { log } from "../log.js";
import type { MessageCommand } from "./types.js";
import type { RemoteImage } from "../chat.js";

/**
 * "Ask EousBot" on any message: right-click -> Apps.
 *
 * This exists because replying to a message and mentioning the bot cannot work.
 * `MESSAGE_CONTENT` is a privileged intent, and Discord empties `content`,
 * `embeds` and `attachments` for apps that lack it -- over the gateway *and*
 * over the HTTP API, so fetching the parent of a reply gets nothing back. The
 * documented exceptions are messages the app sent, DMs, messages that mention
 * it, and "the message a message context menu command is used on".
 *
 * That last one is this. A context menu command is the only way to hand the
 * bot somebody else's post without taking the privileged intent, and taking it
 * would mean the bot could read the whole channel -- see README.md on why that
 * property is worth keeping.
 */

/**
 * Messages captured at right-click time, waiting for their modal.
 *
 * The capture has to happen here and cannot be deferred: the exception above
 * covers the interaction's own payload, not the message id. Re-fetching the
 * same message from the modal submit returns it emptied, so what the context
 * menu saw is the only copy there will be.
 *
 * Attachment URLs are kept rather than their bytes -- a download would not fit
 * in the three seconds an interaction has to be answered in, and Discord's CDN
 * links outlive the fifteen-minute modal window comfortably.
 */
interface PendingAsk {
  text: string;
  images: RemoteImage[];
  author: string;
  at: number;
}

/** Discord's interaction token lifetime; a modal cannot be submitted after it. */
const PENDING_TTL_MS = 15 * 60_000;

const pending = new Map<string, PendingAsk>();

function prune(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [key, value] of pending) if (value.at < cutoff) pending.delete(key);
}

export const command: MessageCommand = {
  data: new ContextMenuCommandBuilder()
    .setName("Ask EousBot")
    .setType(ApplicationCommandType.Message),
  // Admin-only for the same reason mentions are: in hostAuth mode every answer
  // is billed to the host account's Claude login. See README.md.
  adminOnly: true,

  async execute(interaction: MessageContextMenuCommandInteraction): Promise<void> {
    if (!config.chat.enabled) {
      await interaction.reply({
        content: "I'm not set up to answer questions — `CHAT_ENABLED` is off.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const target = interaction.targetMessage;
    const images = imagesFrom(target.attachments.values());

    if (!target.content.trim() && images.length === 0) {
      await interaction.reply({
        content:
          "There's nothing in that message I can read — no text, and no image I support. " +
          "Embeds and link previews don't come through either.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    prune();
    pending.set(interaction.id, {
      text: target.content,
      images,
      author: target.author.username,
      at: Date.now(),
    });

    // showModal must be the first response to an interaction, so the capture
    // above happens before it and nothing is awaited in between.
    await interaction.showModal(buildAskModal(interaction.id, target.author.username));
  },
};

/**
 * Answers the modal opened above.
 *
 * The reply is public rather than ephemeral: the question is about a message
 * everyone in the channel can see, and an answer only the asker can read is
 * the wrong shape for that.
 */
export async function handleAskModal(
  interaction: ModalSubmitInteraction,
  key: string,
): Promise<void> {
  const captured = pending.get(key);
  pending.delete(key);

  if (!captured) {
    await interaction.reply({
      content:
        "I've lost track of which message that was — a restart, or it sat too long. " +
        "Right-click it again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const question = interaction.fields.getTextInputValue(QUESTION_INPUT_ID).trim();
  await interaction.deferReply();

  try {
    const { images, skipped } = await downloadImages(captured.images);
    const result = await answer({
      text: question,
      images,
      askedBy: interaction.user.username,
      quoted: { author: captured.author, text: captured.text },
    });

    if (!result.ok) {
      await interaction.editReply(`I couldn't answer that — ${result.error.slice(0, 400)}`);
      return;
    }

    const note = skipped.length > 0 ? `\n\n-# Couldn't read: ${skipped.join(", ")}` : "";
    const chunks = splitForDiscord(
      (question ? `> ${question.split("\n")[0]?.slice(0, 150)}\n\n` : "") + result.reply + note,
    );

    await interaction.editReply(chunks[0] ?? "(nothing to say)");
    for (const chunk of chunks.slice(1)) await interaction.followUp(chunk);
  } catch (err) {
    log.error("Ask modal threw", { err: String(err) });
    await interaction
      .editReply("That broke something. Check my logs.")
      .catch(() => undefined);
  }
}
