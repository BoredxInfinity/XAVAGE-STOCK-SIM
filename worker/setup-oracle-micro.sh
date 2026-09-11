#!/usr/bin/env bash
# Xavage price worker -- setup for a 1 GB Oracle VM.Standard.E2.1.Micro.
#
# Runs the worker directly under systemd rather than Docker: measured peak is
# ~320 MB, and on a 1 GB box the Docker daemon's ~70 MB is worth not spending.
# Idempotent -- re-run to update to the latest commit.
set -euo pipefail

REPO_DIR="${HOME}/XAVAGE-STOCK-SIM"
SERVICE=xavage-worker

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
die() { printf "\n\033[1;31mERROR: %s\033[0m\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- swap
# Insurance, not a crutch. Peak is ~320 MB against ~1 GB total with Ubuntu
# taking ~200 MB, so it should never be touched -- but if the initial history
# backfill ever spikes, swapping beats the OOM killer picking off sshd and
# locking you out of the box.
if ! sudo swapon --show | grep -q swapfile; then
  say "Adding 2 GB swap"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  # Prefer reclaiming cache over swapping the worker out.
  sudo sysctl -q vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
else
  say "Swap already configured"
fi

# ---------------------------------------------------------------- packages
say "Installing Python and git"
sudo apt-get update -qq
sudo apt-get install -y -qq python3 python3-venv python3-dev git build-essential

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
  git -C "$REPO_DIR" remote set-url origin "https://github.com/BoredxInfinity/XAVAGE-STOCK-SIM.git"
  echo "Token removed from git config."
fi

# ---------------------------------------------------------------- venv
say "Building the virtualenv"
cd "$REPO_DIR/worker"
[ -d .venv ] || python3 -m venv .venv
./.venv/bin/pip install --quiet --upgrade pip

# The lockfile was frozen on a different Python minor version, so some exact
# pins may have no wheel here. Try it, then fall back to the direct pins.
if ! ./.venv/bin/pip install --quiet -r requirements.lock.txt 2>/dev/null; then
  echo "  lockfile didn't resolve on this Python; using requirements.txt"
  ./.venv/bin/pip install --quiet -r requirements.txt
fi
./.venv/bin/python -c "import yfinance, pandas; from supabase import create_client" \
  || die "Dependency check failed."
echo "  dependencies OK"

# ---------------------------------------------------------------- config
ENV_FILE="$REPO_DIR/worker/.env"
if [ ! -f "$ENV_FILE" ]; then
  say "Supabase credentials"
  read -rp  "SUPABASE_URL: " SB_URL
  read -rsp "SUPABASE_SERVICE_ROLE_KEY (input hidden): " SB_KEY; echo

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
# Smaller batches keep each yfinance DataFrame smaller on a 1 GB box.
BATCH_SIZE=25
EOF
  chmod 600 "$ENV_FILE"
  echo "  wrote $ENV_FILE (permissions 600)"
else
  say "Reusing existing $ENV_FILE"
fi

# ---------------------------------------------------------------- systemd
say "Installing the systemd service"
sudo tee /etc/systemd/system/${SERVICE}.service >/dev/null <<EOF
[Unit]
Description=Xavage price worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${REPO_DIR}/worker
EnvironmentFile=${REPO_DIR}/worker/.env
ExecStart=${REPO_DIR}/worker/.venv/bin/python poller.py
Restart=always
RestartSec=10

# Cap the worker so a runaway is restarted by systemd instead of the kernel
# OOM killer choosing a victim -- which on a 1 GB box could be sshd.
MemoryAccounting=true
MemoryMax=700M

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE} >/dev/null 2>&1
sudo systemctl restart ${SERVICE}

say "Started. Following the log -- Ctrl-C stops watching, not the worker."
sleep 3
sudo journalctl -u ${SERVICE} -f -n 30 --no-hostname
