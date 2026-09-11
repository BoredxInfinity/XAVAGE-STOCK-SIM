#!/usr/bin/env bash
#
# Xavage price worker installer -- Oracle Linux (and Ubuntu) on a 1 GB VM.
#
# Installs one dependency (yfinance), writes a systemd unit, smoke-tests the
# config against Supabase, and starts the service. No Docker, no compiler, no
# third-party repos. Safe to re-run: it is also the upgrade path.
#
#   git clone <repo> ~/XAVAGE-STOCK-SIM
#   bash ~/XAVAGE-STOCK-SIM/worker/setup.sh
#
# Unattended:
#   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... bash worker/setup.sh
set -euo pipefail

WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${XAVAGE_VENV:-$HOME/.xavage-venv}"
SERVICE=xavage-worker
UNIT=/etc/systemd/system/${SERVICE}.service
RUN_USER="$(id -un)"

say()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$WORKER_DIR/poller.py" ] || die "run this from a checkout: bash worker/setup.sh"
command -v sudo >/dev/null || die "sudo is required"

# --------------------------------------------------------------- interpreter
# Oracle Linux 9 ships Python 3.9 as /usr/bin/python3, and yfinance cannot run
# on it: curl_cffi declares Requires-Python >=3.10 and pandas 3 wants >=3.11.
# So prefer any newer interpreter already present, and only then reach for
# python3.11 -- which is a stock AppStream RPM, not a third-party build.
find_python() {
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null \
      && { echo "$candidate"; return 0; }
  done
  return 1
}

if ! PY="$(find_python)"; then
  say "No Python 3.10+ present -- installing one from the distro's own repo"
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y python3.11 python3.11-pip
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y python3 python3-venv python3-pip
  else
    die "no dnf or apt-get; install Python 3.10+ manually and re-run"
  fi
  PY="$(find_python)" || die "still no Python 3.10+ after install"
fi
say "Using $($PY -c 'import sys,platform; print(platform.python_implementation(), sys.version.split()[0], "at", sys.executable)')"

# ---------------------------------------------------------------------- swap
# 1 GB with no swap means the one-time chart backfill can OOM the box. Steady
# state is ~260 MB, so this is insurance rather than a running cost.
mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
swap_kb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 2000000 ] && [ "$swap_kb" -lt 262144 ]; then
  say "Only $((mem_kb/1024)) MB RAM and no swap -- adding a 2 GB swapfile"
  sudo fallocate -l 2G /swapfile 2>/dev/null || \
    sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  # A small box should lean on swap only under real pressure.
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-xavage.conf >/dev/null
  sudo sysctl -q -w vm.swappiness=10
else
  note "memory: $((mem_kb/1024)) MB RAM, $((swap_kb/1024)) MB swap -- leaving as is"
fi

# ------------------------------------------------------------------- install
say "Installing yfinance into $VENV"
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --disable-pip-version-check --upgrade pip
# --only-binary=:all: refuses source builds outright. Every dependency
# publishes manylinux/aarch64 wheels, so this never needs gcc -- and if a
# wheel ever goes missing it fails in seconds instead of compiling numpy for
# half an hour on a shared core.
"$VENV/bin/python" -m pip install --no-cache-dir --disable-pip-version-check \
  --only-binary=:all: --upgrade -r "$WORKER_DIR/requirements.txt"
note "$("$VENV/bin/python" -m pip list --disable-pip-version-check 2>/dev/null | tail -n +3 | wc -l) packages installed"

# ---------------------------------------------------------------------- .env
ENV_FILE="$WORKER_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  say "Supabase credentials"
  url="${SUPABASE_URL:-}"
  key="${SUPABASE_SERVICE_ROLE_KEY:-}"
  [ -n "$url" ] || read -r -p "  SUPABASE_URL (https://<ref>.supabase.co): " url
  if [ -z "$key" ]; then
    read -r -s -p "  SUPABASE_SERVICE_ROLE_KEY (hidden): " key; echo
  fi
  url="${url%/}"
  case "$url" in https://*|http://*) ;; *) die "SUPABASE_URL must start with https://" ;; esac
  # A service-role key is a JWT. Catching a mispaste here saves a long hunt
  # through "Illegal header value" later.
  [ "$(printf '%s' "$key" | tr -cd . | wc -c)" -eq 2 ] \
    || die "that key is not a JWT (expected three dot-separated parts)"
  umask 077
  cat > "$ENV_FILE" <<EOF
SUPABASE_URL=$url
SUPABASE_SERVICE_ROLE_KEY=$key
POLL_INTERVAL_SECONDS=${POLL_INTERVAL_SECONDS:-5}
IDLE_INTERVAL_SECONDS=${IDLE_INTERVAL_SECONDS:-120}
HISTORY_INTERVAL_SECONDS=${HISTORY_INTERVAL_SECONDS:-1800}
MAX_SYMBOLS=${MAX_SYMBOLS:-400}
EOF
  chmod 600 "$ENV_FILE"
  note "wrote $ENV_FILE (0600)"
else
  note "keeping existing $ENV_FILE"
fi

# --------------------------------------------------------------- smoke test
# One real cycle before anything is enabled: proves the interpreter, the
# dependency tree, the credentials and the egress path all work, with the
# failure printed right here instead of buried in the journal.
say "Running one cycle to verify"
( cd "$WORKER_DIR" && "$VENV/bin/python" poller.py --once ) \
  || die "the test cycle failed -- fix the error above before enabling the service"

# ------------------------------------------------------------------ systemd
say "Installing the $SERVICE service"
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Xavage price worker
Documentation=https://github.com/BoredxInfinity/XAVAGE-STOCK-SIM
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$WORKER_DIR
ExecStart=$VENV/bin/python -u poller.py
Restart=always
RestartSec=10
TimeoutStopSec=30

# Steady state measures ~260 MB. MemoryHigh reclaims under pressure, MemoryMax
# is the hard stop -- together they keep the worker from being the process that
# takes down a 1 GB box, without tripping during the one-time backfill.
MemoryAccounting=yes
MemoryHigh=600M
MemoryMax=800M

Environment=PYTHONUNBUFFERED=1
# glibc hands every thread its own malloc arena; on one shared core that is
# pure resident memory for no throughput gain.
Environment=MALLOC_ARENA_MAX=2
# numpy's BLAS sizes its scratch buffers by core count at import. Nothing here
# is a matrix workload.
Environment=OPENBLAS_NUM_THREADS=1
Environment=OMP_NUM_THREADS=1

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE"
sleep 3
sudo systemctl --no-pager --lines=0 status "$SERVICE" || true

cat <<EOF

$(say "Done")
    logs      journalctl -u $SERVICE -f
    memory    systemctl show $SERVICE -p MemoryCurrent
    restart   sudo systemctl restart $SERVICE
    update    cd $(dirname "$WORKER_DIR") && git pull && sudo systemctl restart $SERVICE

EOF
