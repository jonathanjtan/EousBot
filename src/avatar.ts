/**
 * Which avatars a user has and where to find them at full size.
 *
 * Kept outside the command handler so the suite can test it without booting
 * config (which exits the process when secrets are absent), and without a
 * Discord client.
 */

/** The largest size Discord's CDN serves. Animated avatars come back as GIFs. */
export const AVATAR_SIZE = 4096;

/** The slice of `User` and `GuildMember` this module needs. */
export interface AvatarSource {
  displayAvatarURL(options: { size: number }): string;
}

export interface AvatarView {
  label: string;
  url: string;
}

/**
 * The avatars worth showing, most specific first: a per-server avatar when the
 * member has one, then the account-wide one.
 */
export function avatarViews(user: AvatarSource, member: AvatarSource | null): AvatarView[] {
  const global: AvatarView = {
    label: "Global avatar",
    url: user.displayAvatarURL({ size: AVATAR_SIZE }),
  };
  if (member === null) return [global];

  // GuildMember falls back to the account avatar when no per-server one is set,
  // so matching URLs mean there is only one picture to show.
  const guild = member.displayAvatarURL({ size: AVATAR_SIZE });
  if (guild === global.url) return [global];

  return [{ label: "Server avatar", url: guild }, global];
}
