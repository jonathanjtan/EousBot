/** The fields of a command payload that the comparison below reads. */
export interface CommandShape {
  name?: string;
  description?: string;
  type?: number;
  options?: unknown[];
}

/**
 * A comparable shape covering the fields that actually affect what Discord
 * serves.
 *
 * Discord's responses carry fields the local payload never sets (`id`,
 * `application_id`, `version`, permission defaults), so comparing whole
 * objects reports a difference on every boot. Projecting both sides through
 * the same narrow shape is what makes "has anything really changed?"
 * answerable.
 *
 * Options are projected all the way down, choices included. /claude keeps its
 * model menu in a top-level option's choices and /chat keeps its menu inside a
 * subcommand, and a projection that stopped at top-level names reported
 * "already up to date" while Discord went on serving the old menus.
 */
export function commandSignature(cmd: CommandShape): string {
  // Defaulted rather than passed through: builders omit `type` for a slash
  // command while Discord echoes back 1, and an unnormalised comparison would
  // report a difference on every boot and re-register forever.
  return JSON.stringify({
    name: cmd.name,
    type: cmd.type ?? 1,
    description: cmd.description ?? "",
    options: projectOptions(cmd.options),
  });
}

function projectOptions(options: unknown[] | undefined): unknown[] {
  return (options ?? []).map((raw) => {
    const o = raw as {
      name?: string;
      description?: string;
      type?: number;
      required?: boolean;
      choices?: { name?: string; value?: unknown }[];
      options?: unknown[];
    };
    return {
      name: o.name,
      description: o.description,
      type: o.type,
      // Discord echoes this back explicitly; builders omit it when false.
      required: o.required ?? false,
      // Name and value only: Discord echoes localization fields nobody set.
      choices: (o.choices ?? []).map((c) => ({ name: c.name, value: c.value })),
      options: projectOptions(o.options),
    };
  });
}
