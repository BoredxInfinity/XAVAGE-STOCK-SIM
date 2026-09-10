#!/usr/bin/env bash
# Xavage price worker -- one-shot setup for an Oracle Cloud VM (Ubuntu).
#
#   curl -fsSL <raw-url> | bash        (or paste this file and run it)
#
# Idempotent: safe to re-run to update the worker to the latest commit.
set -euo pipefail

REPO_DIR="${HOME}/XAVAGE-STOCK-SIM"
IMAGE="xavage-worker"
CONTAINER="xavage-worker"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
die() { printf "\n\033[1;31mERROR: %s\033[0m\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- docker
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl git
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER" || true
else
  say "Docker already installed"
fi

DOCKER="sudo docker"

# ---------------------------------------------------------------- source
if [ -d "$REPO_DIR/.git" ]; then
  say "Updating existing checkout"
  git -C "$REPO_DIR" pull --ff-only
else
  say "Cloning the repository"
  echo "The repo is private, so this needs a GitHub token with read access."
  echo "Create one at: https://github.com/settings/personal-access-tokens"
  echo "  Repository access: only XAVAGE-STOCK-SIM   Permission: Contents = Read"
  read -rsp "GitHub token (input hidden): " GH_TOKEN; echo
  [ -n "$GH_TOKEN" ] || die "No token supplied."
  git clone "https://${GH_TOKEN}@github.com/BoredxInfinity/XAVAGE-STOCK-SIM.git" "$REPO_DIR" \
    || die "Clone failed -- check the token has Contents:Read on this repo."
  # Don't leave the token sitting in .git/config
  git -C "$REPO_DIR" remote set-url origin \
    "https://github.com/BoredxInfinity/XAVAGE-STOCK-SIM.git"
  echo "Token removed from git config (you'll be asked again on the next update)."
fi

# ---------------------------------------------------------------- config
ENV_FILE="$REPO_DIR/worker/.env"
if [ ! -f "$ENV_FILE" ]; then
  say "Supabase credentials"
  read -rp  "SUPABASE_URL: " SB_URL
  read -rsp "SUPABASE_SERVICE_ROLE_KEY (input hidden): " SB_KEY; echo

  # Catch the multi-line paste mistake before it becomes an unreadable
  # 'Illegal header value' at runtime.
  case "$SB_KEY" in
    *[$'\n\r\t ']*) die "The key contains whitespace or a line break. Paste ONLY the key." ;;
  esac
  [ "$(echo "$SB_KEY" | tr -cd '.' | wc -c)" -eq 2 ] \
    || die "That doesn't look like a JWT (expected three dot-separated parts)."

  cat > "$ENV_FILE" <<EOF
SUPABASE_URL=${SB_URL}
SUPABASE_SERVICE_ROLE_KEY=${SB_KEY}
POLL_INTERVAL_SECONDS=5
IDLE_INTERVAL_SECONDS=120
HISTORY_INTERVAL_SECONDS=1800
MAX_SYMBOLS=400
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE (permissions 600)."
else
  say "Reusing existing $ENV_FILE"
fi

# ---------------------------------------------------------------- run
say "Building the image (a few minutes on first run)"
$DOCKER build -t "$IMAGE" "$REPO_DIR/worker"

say "Starting the worker"
$DOCKER rm -f "$CONTAINER" >/dev/null 2>&1 || true
$DOCKER run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  --log-opt max-size=10m --log-opt max-file=3 \
  "$IMAGE"

say "Done. Following the log -- Ctrl-C stops watching, not the worker."
sleep 3
$DOCKER logs -f --tail 30 "$CONTAINER"
