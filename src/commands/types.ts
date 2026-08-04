import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

/**
 * The contract every slash command module satisfies.
 *
 * Agent-written commands land here too, so keep this surface small and obvious:
 * a builder describing the command, and a handler. Anything a command needs
 * beyond that should be imported, not threaded through this interface.
 */
export interface Command {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  /** Restrict to DISCORD_ADMIN_IDS. Defaults to false (anyone may run it). */
  adminOnly?: boolean;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
