import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ContextMenuCommandBuilder,
  MessageContextMenuCommandInteraction,
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
  /** Suggestions for an option built with `setAutocomplete(true)`. */
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

/**
 * The same contract for a message context menu command -- the "Apps" entry on
 * a right-clicked message.
 *
 * Separate from `Command` because Discord treats them as different types with
 * different payloads: no description, no options, and an interaction that
 * carries the message it was used on. That message is the whole point; see
 * commands/ask.ts for why it cannot be fetched any other way.
 */
export interface MessageCommand {
  data: ContextMenuCommandBuilder;
  /** Restrict to DISCORD_ADMIN_IDS. Defaults to false (anyone may run it). */
  adminOnly?: boolean;
  execute: (interaction: MessageContextMenuCommandInteraction) => Promise<void>;
}
