#!/usr/bin/env bash
# Xavage price worker -- Docker setup for an Oracle Cloud VM.
# Works on Oracle Linux / RHEL (dnf) and Ubuntu / Debian (apt).
#
# Docker is the quicker route on a small instance: the python:3.12-slim base
# image already has Python, so the VM never installs python3.12, -devel or gcc
# from the distro repos, which is what makes the from-source path slow on
# 1 OCPU.
#
# Idempotent -- re-run to update to the latest commit.
#
# Unattended (survives a dropped SSH session):
#   GH_TOKEN=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
#     nohup bash setup.sh > setup.log 2>&1 &
set -euo pipefail

REPO_DIR="${HOME}/XAVAGE-STOCK-SIM"
IMAGE=xavage-worker
CONTAINER=xavage-worker

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
die() { printf "\n\033[1;31mERROR: %s\033[0m\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- swap
# The build peaks higher than the running worker (~320 MB). On a 1 GB box this
# is what stops the kernel OOM killer picking a victim mid-build -- which could
# be sshd, locking you out.
if ! sudo swapon --show 2>/dev/null | grep -q swapfile; then
  say "Adding 2 GB swap"
  sudo fallocate -l 2G /swapfile 2>/dev/null \
    || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  sudo sysctl -q vm.swappiness=10 || true
else
  say "Swap already configured"
fi

# ---------------------------------------------------------------- docker
if ! command -v docker >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    say "Installing Docker (Oracle Linux / RHEL)"
    sudo dnf install -y -q dnf-plugins-core git
    # dnf4 uses --add-repo; dnf5 renamed it to addrepo --from-repofile
    sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null \
      || sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/centos/docker-ce.repo
    # --allowerasing lets docker-ce replace podman's runc if it's present
    sudo dnf install -y -q --allowerasing docker-ce docker-ce-cli containerd.io
  elif command -v apt-get >/dev/null 2>&1; then
    say "Installing Docker (Debian / Ubuntu)"
    sudo apt-get update -qq
    sudo apt-get install -y -qq ca-certificates curl git
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io
  else
    die "No supported package manager found (looked for dnf and apt-get)."
  fi
  sudo systemctl enable --now docker
else
  say "Docker already installed"
  sudo systemctl enable --now docker 2>/dev/null || true
fi

# ---------------------------------------------------------------- source
if [ -d "$REPO_DIR/.git" ]; then
  say "Updating existing checkout"
  git -C "$REPO_DIR" pull --ff-only
else
  say "Cloning the repository"
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "The repo is private, so this needs a GitHub token with read access."
    echo "Create one at: https://github.com/settings/personal-access-tokens"
    echo "  Repository access: only XAVAGE-STOCK-SIM   Permission: Contents = Read"
    read -rsp "GitHub token (input hidden): " GH_TOKEN; echo
  fi
  [ -n "${GH_TOKEN:-}" ] || die "No token supplied (set GH_TOKEN to run unattended)."
  git clone --depth 1 "https://${GH_TOKEN}@github.com/BoredxInfinity/XAVAGE-STOCK-SIM.git" "$REPO_DIR" \
    || die "Clone failed -- check the token has Contents:Read on this repo."
  git -C "$REPO_DIR" remote set-url origin "https://github.com/BoredxInfinity/XAVAGE-STOCK-SIM.git"
  echo "  token removed from git config"
fi

# ---------------------------------------------------------------- config
ENV_FILE="$REPO_DIR/worker/.env"
if [ ! -f "$ENV_FILE" ]; then
  say "Supabase credentials"
  SB_URL="${SUPABASE_URL:-}"
  SB_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
  [ -n "$SB_URL" ] || read -rp  "SUPABASE_URL: " SB_URL
  if [ -z "$SB_KEY" ]; then
    read -rsp "SUPABASE_SERVICE_ROLE_KEY (input hidden): " SB_KEY; echo
  fi
  [ -n "$SB_URL" ] && [ -n "$SB_KEY" ] \
    || die "Missing credentials (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run unattended)."

  # Reject the multi-line paste before it becomes an unreadable
  # 'Illegal header value' at runtime.
  case "$SB_KEY" in
    *[$'\n\r\t ']*) die "The key contains whitespace or a line break. Paste ONLY the key." ;;
  esac
  [ "$(printf '%s' "$SB_KEY" | tr -cd '.' | wc -c)" -eq 2 ] \
    || die "That doesn't look like a JWT (expected three dot-separated parts)."

  cat > "$ENV_FILE" <<EOF
SUPABASE_URL=${SB_URL}
SUPABASE_SERVICE_ROLE_KEY=${SB_KEY}
POLL_INTERVAL_SECONDS=5
IDLE_INTERVAL_SECONDS=120
HISTORY_INTERVAL_SECONDS=1800
MAX_SYMBOLS=400
BATCH_SIZE=25
EOF
  chmod 600 "$ENV_FILE"
  echo "  wrote $ENV_FILE (permissions 600)"
else
  say "Reusing existing $ENV_FILE"
fi

# ---------------------------------------------------------------- run
say "Building the image (a few minutes on 1 OCPU)"
sudo docker build -t "$IMAGE" "$REPO_DIR/worker"

say "Starting the worker"
sudo docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
sudo docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  --memory 700m \
  --log-opt max-size=10m --log-opt max-file=3 \
  "$IMAGE"

if [ -t 1 ]; then
  say "Started. Following the log -- Ctrl-C stops watching, not the worker."
  sleep 3
  sudo docker logs -f --tail 30 "$CONTAINER"
else
  say "Started. Recent log:"
  sleep 25
  sudo docker logs --tail 30 "$CONTAINER" 2>&1 || true
  echo
  echo "Setup complete. The container restarts on boot and survives disconnects."
  echo "  sudo docker logs -f xavage-worker"
fi
