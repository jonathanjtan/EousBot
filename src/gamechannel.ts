import type { Client, TextChannel } from "discord.js";
import { config } from "./config.js";
// A pure function over strings. It lives in the idle game's formatter because
// that game needed it first; both games post through here now.
import { batch } from "./idlerpg/format.js";
import { log } from "./log.js";

/**
 * The channel both games talk in, and the only way either of them reaches a
 * player.
 *
 * Neither game DMs anybody. A bot that opens a private conversation to say you
 * found a helmet is a bot people mute, and half the realm's appeal is that it
 * is a place with things happening in it rather than a feed only you can see.
 * So every line the engines produce lands in IDLERPG_CHANNEL_ID, and a line
 * about one player names them instead of pinging them. The one exception is
 * the dispatch game's claim reminder, which does mention: it is the only
 * message that needs an action from the person it is about.
 */

/** Discord rejects a message over 2000 characters outright; this leaves room. */
const MESSAGE_LIMIT = 1_900;

/**
 * Resolves the game channel, saying clearly why it could not.
 *
 * The three failure modes are worth separating because they have different
 * fixes and only one of them throws: a wrong id resolves to nothing, a right
 * id pointing at a category or a voice channel resolves to something that
 * cannot be posted to, and a channel the bot cannot see raises. Returning null
 * silently for the first two -- which is what this code used to do -- means a
 * misconfigured realm narrates into the void forever and logs nothing at all,
 * and that is precisely the state a fresh install is most likely to be in.
 */
export async function gameChannel(client: Client | null): Promise<TextChannel | null> {
  const id = config.idlerpg.channelId;
  try {
    const channel = await client?.channels.fetch(id);
    if (!channel) {
      log.warn("IDLERPG_CHANNEL_ID does not resolve to a channel", { channelId: id });
      return null;
    }
    if (!channel.isTextBased() || !("send" in channel)) {
      log.warn("IDLERPG_CHANNEL_ID is not a channel the bot can post to", {
        channelId: id,
        type: channel.type,
      });
      return null;
    }
    return channel as TextChannel;
  } catch (err) {
    log.warn("Could not reach the game channel", { channelId: id, err: String(err) });
    return null;
  }
}

/**
 * Posts lines as few messages as Discord will take.
 *
 * Returns whether all of them landed, which the claim reminder needs: it marks
 * a character as told only once the channel has actually seen it, so a Discord
 * hiccup costs a minute rather than the reminder itself.
 */
export async function announce(client: Client | null, lines: string[]): Promise<boolean> {
  if (lines.length === 0) return true;
  const channel = await gameChannel(client);
  if (!channel) return false;

  for (const chunk of batch(lines, MESSAGE_LIMIT)) {
    try {
      await channel.send(chunk);
    } catch (err) {
      log.warn("Could not deliver a game announcement", { err: String(err) });
      return false;
    }
  }
  return true;
}

/**
 * Confirms at boot that the games have somewhere to talk.
 *
 * Cheap, and it moves the discovery of a bad channel id from "somebody
 * eventually notices the game has been silent for a week" to the first ten
 * lines of the log after a deploy. Unconditional, because the dispatch game
 * always runs and its claim reminders post here too.
 */
export async function checkGameChannel(client: Client): Promise<void> {
  const channel = await gameChannel(client);
  if (channel) {
    log.info("Game channel ready", { channel: channel.name, channelId: channel.id });
  } else {
    log.error(
      "The games have nowhere to post. They will run and nobody will see them. " +
        "Check IDLERPG_CHANNEL_ID and that the bot can view and send in that channel.",
    );
  }
}
