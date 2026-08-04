#!/usr/bin/env bash
#
# Install EousBot onto an existing Linux box (e.g. kf-dev) as a systemd *user*
# service. Idempotent: re-running reconciles rather than duplicating.
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

# ------------------------------------------------------------------ code ---
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "Updating existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" reset --hard "origin/$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD)"
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

# Point the unit's REPO_PATH at wherever we actually installed.
if ! grep -q "^REPO_PATH=$INSTALL_DIR$" "$INSTALL_DIR/.env" 2>/dev/null; then
  if grep -q "^REPO_PATH=" "$INSTALL_DIR/.env"; then
    sed -i "s|^REPO_PATH=.*|REPO_PATH=$INSTALL_DIR|" "$INSTALL_DIR/.env"
  else
    echo "REPO_PATH=$INSTALL_DIR" >> "$INSTALL_DIR/.env"
  fi
  log "Set REPO_PATH=$INSTALL_DIR"
fi

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
