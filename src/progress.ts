import { log } from "./log.js";
import type {
  ChatInputCommandInteraction,
  InteractionReplyOptions,
  Message,
  MessageCreateOptions,
  ModalSubmitInteraction,
} from "discord.js";

/**
 * A handle on the bot's own reply, edited through the bot token.
 *
 * An interaction token dies fifteen minutes after the reply is deferred, and
 * builds routinely run longer than that -- #62 ran thirty-nine minutes. Every
 * progress edit past the deadline failed, and so did the message saying the
 * build had failed, so the request sat on screen looking frozen at whatever
 * line happened to be showing at minute fifteen.
 *
 * Fetching the reply once turns it into an ordinary Message, which the bot can
 * edit for as long as it exists. The follow-up goes to the channel for the same
 * reason: `interaction.followUp` is the same expiring webhook.
 *
 * The first write is the exception, and has to go through the webhook: it is
 * the only thing that clears the LOADING flag behind "<bot> is thinking...".
 */
export interface Progress {
  /** Latest progress line. Call as fast as it changes; sending is coalesced. */
  update(line: string): void;
  /** Final text, and the end of progress updates. */
  finish(content: string): Promise<void>;
  /** A further message in the same channel, outliving the interaction token. */
  followUp(payload: MessageCreateOptions & InteractionReplyOptions): Promise<void>;
  /** Ends progress updates without writing anything. */
  stop(): void;
}

/** Discord rate-limits edits well below the rate an agent emits progress. */
const FLUSH_MS = 4000;

export async function startProgress(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  header: string,
): Promise<Progress> {
  // The one call that has to use the interaction token, made immediately after
  // the defer while it is certainly still good.
  const reply: Message | null = await interaction.fetchReply().catch((err: unknown) => {
    log.warn("Could not fetch the deferred reply; falling back to the interaction token", {
      err: String(err),
    });
    return null;
  });

  // The deferred reply carries Discord's LOADING flag, which the client draws as
  // "<bot> is thinking...". Only the interaction webhook clears that flag. A
  // bot-token edit goes to PATCH /channels/:id/messages/:id, which rewrites the
  // content and stamps "(edited)" but leaves the flag set -- so every line below
  // lands on a message still showing the placeholder, and a perfectly healthy
  // run reads as hung from its first second to its last. Spend the token on the
  // first write to clear it, then switch to the Message, which never expires.
  let loadingCleared = false;
  const edit = async (content: string): Promise<unknown> => {
    if (!loadingCleared) {
      try {
        const first = await interaction.editReply(content);
        loadingCleared = true;
        return first;
      } catch (err) {
        // Past the fifteen-minute deadline the flag can no longer be cleared.
        // A stuck placeholder beats losing the text underneath it.
        if (!reply) throw err;
        loadingCleared = true;
        log.warn("Could not clear the thinking placeholder; editing the message instead", {
          err: String(err),
        });
      }
    }
    return reply ? reply.edit(content) : interaction.editReply(content);
  };

  let latest: string | null = null;
  let warned = false;

  const timer = setInterval(() => {
    if (latest === null) return;
    const line = latest;
    latest = null;
    edit(`${header}\n\`${line}\``).catch((err: unknown) => {
      // Once per run. A broken edit breaks every four seconds after that, and
      // only the first one carries any information.
      if (warned) return;
      warned = true;
      log.warn("Progress edit failed; the run itself is unaffected", { err: String(err) });
    });
  }, FLUSH_MS);

  const stop = (): void => clearInterval(timer);

  return {
    update: (line) => {
      latest = line;
    },
    stop,
    finish: async (content) => {
      // Before the write, so a pending flush cannot land on top of the outcome.
      stop();
      await edit(content).catch((err: unknown) => {
        log.error("Could not post the outcome", { err: String(err) });
      });
    },
    followUp: async (payload) => {
      const channel = reply?.channel ?? interaction.channel;
      const sent = channel?.isSendable()
        ? channel.send(payload)
        : interaction.followUp(payload);
      await sent.catch((err: unknown) => {
        log.error("Could not post the follow-up", { err: String(err) });
      });
    },
  };
}
