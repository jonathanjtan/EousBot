#!/usr/bin/env bash
#
# Install EousBot onto a Linux box as a systemd *user* service.
# Idempotent: re-running reconciles rather than duplicating.
#
#   ./install.sh              install or update
#   ./install.sh --no-start   set everything up but don't start the unit
#
# A user unit rather than a system one, for one specific reason: the bot
# restarts itself after a self-deploy, and `systemctl --user restart` needs no
# sudo and no NOPASSWD sudoers entry. A system unit would require granting the
# bot's account passwordless sudo, which is a far larger privilege than
# "restart yourself".
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/jonathanjtan/EousBot.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/EousBot}"
UNIT_NAME="eousbot.service"
NO_START=0

for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- preflight ---
command -v git  >/dev/null || die "git not found"
command -v node >/dev/null || die "node not found (need >= 22)"
command -v npm  >/dev/null || die "npm not found"
command -v systemctl >/dev/null || die "systemctl not found"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "node $NODE_MAJOR is too old; need >= 22"

# The Agent SDK ships no binary; it resolves `claude` from PATH. The unit adds
# ~/.local/bin explicitly, so check the place the unit will actually look
# rather than trusting this shell's PATH (which sources profile.d and lies).
CLAUDE_BIN=""
for candidate in "$HOME/.local/bin/claude" "/usr/local/bin/claude" "$(command -v claude 2>/dev/null || true)"; do
  [[ -n "$candidate" && -x "$candidate" ]] && { CLAUDE_BIN="$candidate"; break; }
done
if [[ -z "$CLAUDE_BIN" ]]; then
  warn "claude CLI not found. Builds will fail until it is installed:"
  warn "  curl -fsSL https://claude.ai/install.sh | bash"
else
  log "Found claude at $CLAUDE_BIN"
  # hostAuth mode (blank ANTHROPIC_API_KEY) needs a logged-in CLI on this box.
  if [[ ! -f "$HOME/.claude/.credentials.json" ]]; then
    warn "claude is installed but not logged in, and no ANTHROPIC_API_KEY is set."
    warn "Run 'claude' once to authenticate, or set ANTHROPIC_API_KEY in .env."
  fi
fi

# ------------------------------------------------------------------ code ---
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "Updating existing checkout at $INSTALL_DIR"
  BEFORE="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" reset --hard "origin/$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD)"
  AFTER="$(git -C "$INSTALL_DIR" rev-parse HEAD)"

  # This script lives in the tree it just replaced. bash reads scripts
  # incrementally by byte offset, so continuing here would run a spliced
  # mixture of the old and new file -- which is exactly how SYSTEMD_UNIT
  # silently failed to get set on the first deploy. Re-exec the new version
  # instead, once, guarded against looping.
  if [[ "$BEFORE" != "$AFTER" && -z "${EOUS_INSTALL_REEXEC:-}" ]]; then
    log "install.sh changed ($(printf %.8s "$BEFORE") -> $(printf %.8s "$AFTER")); re-executing"
    EOUS_INSTALL_REEXEC=1 exec bash "$INSTALL_DIR/infra/$(basename "$0")" "$@"
  fi
else
  log "Cloning $REPO_URL into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# The bot commits as itself; without an identity `git commit` fails mid-build
# with an error that looks nothing like its actual cause.
git -C "$INSTALL_DIR" config user.name  "EousBot"
git -C "$INSTALL_DIR" config user.email "eousbot@users.noreply.github.com"

log "Installing dependencies"
cd "$INSTALL_DIR"
npm ci --no-audit --no-fund

log "Building"
npm run build

# --------------------------------------------------------------- secrets ---
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  warn "Created $INSTALL_DIR/.env from the example. Fill it in before starting:"
  warn "  DISCORD_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID, DISCORD_CHANNEL_ID,"
  warn "  DISCORD_ADMIN_IDS, GITHUB_TOKEN"
  NO_START=1
else
  chmod 600 "$INSTALL_DIR/.env"
  log "Using existing .env (left untouched)"
fi

# Rewrite the two settings that are necessarily machine-specific, so the same
# .env can be copied straight from a dev laptop without hand-editing.
#
# SYSTEMD_UNIT in particular is blank on macOS (no systemd), and leaving it
# blank here would silently degrade self-deploy: PRs merge and build, then
# never restart, and the bot keeps running the old code while reporting
# success.
set_env_var() {
  local key="$1" value="$2" file="$INSTALL_DIR/.env"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

set_env_var REPO_PATH "$INSTALL_DIR"
set_env_var SYSTEMD_UNIT "$UNIT_NAME"
log "Set REPO_PATH=$INSTALL_DIR and SYSTEMD_UNIT=$UNIT_NAME"

# ---------------------------------------------------------------- systemd ---
# Without linger, the user manager is torn down when the last SSH session ends
# -- the bot would die every time you log out, which on a headless box means
# "shortly after install".
if ! loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q 'Linger=yes'; then
  log "Enabling linger so the service survives logout"
  loginctl enable-linger "$USER" || warn "Could not enable linger; you may need: sudo loginctl enable-linger $USER"
fi

mkdir -p "$HOME/.config/systemd/user"
cp "$INSTALL_DIR/infra/$UNIT_NAME" "$HOME/.config/systemd/user/$UNIT_NAME"
systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"

if [[ $NO_START -eq 1 ]]; then
  cat <<DONE

  Installed but not started.

  1. Fill in $INSTALL_DIR/.env
  2. Register slash commands:  cd $INSTALL_DIR && npx tsx src/deploy-commands.ts
  3. Start:                    systemctl --user start $UNIT_NAME
  4. Watch:                    journalctl --user -u $UNIT_NAME -f

DONE
  exit 0
fi

log "Restarting $UNIT_NAME"
systemctl --user restart "$UNIT_NAME"
sleep 2
systemctl --user --no-pager status "$UNIT_NAME" || true

cat <<DONE

  Running. Useful commands:

    journalctl --user -u $UNIT_NAME -f     # follow logs
    systemctl --user restart $UNIT_NAME    # manual restart
    systemctl --user stop $UNIT_NAME       # stop (also stops self-deploys)

  If you added or changed a slash command's shape, re-register it:

    cd $INSTALL_DIR && npx tsx src/deploy-commands.ts

DONE
