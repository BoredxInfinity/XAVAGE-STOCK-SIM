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

LOG="${XAVAGE_LOG:-$HOME/xavage-setup.log}"

# Everything from here is tee'd to $LOG line by line. On a 1 GB box the
# failure mode that matters is the machine going unresponsive, taking the SSH
# session and any scrollback with it -- so the record has to be on disk, where
# it survives a hard reboot from the console.
exec > >(tee -a "$LOG") 2>&1

mem()  { awk '/^MemAvailable:|^SwapFree:/{printf "%s %d MB   ", $1, $2/1024}' /proc/meminfo; echo; }
say()  { printf '\n\033[1;36m==>\033[0m %s\n    ' "$*"; mem; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

trap 'printf "\n\033[1;31mFAILED\033[0m at line %s: %s\n" "$LINENO" "$BASH_COMMAND"' ERR
printf '\n=== %s  setup.sh starting (log: %s) ===\n' "$(date -u +%FT%TZ)" "$LOG"

[ -f "$WORKER_DIR/poller.py" ] || die "run this from a checkout: bash worker/setup.sh"
command -v sudo >/dev/null || die "sudo is required"

# ---------------------------------------------------------------------- swap
# 1 GB with no swap means the one-time chart backfill can OOM the box. Steady
# state is ~260 MB, so this is insurance rather than a running cost.
# This runs FIRST, before anything that allocates. dnf's dependency solver
# routinely wants a few hundred MB, and on 1 GB with no swap it is the step
# most likely to be OOM-killed -- which presents as "installing a package
# killed my server" rather than "you have no swap".
mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
swap_kb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 2000000 ] && [ "$swap_kb" -lt 262144 ]; then
  say "Only $((mem_kb/1024)) MB RAM and no swap -- adding a 2 GB swapfile"
  # dd, not fallocate. OCI boot volumes are XFS, where fallocate produces
  # unwritten extents that swapon rejects with "Invalid argument" -- and
  # because fallocate itself SUCCEEDS, a `fallocate || dd` fallback never
  # fires. Writing the blocks is slower but is the only portable way.
  if [ ! -f /swapfile ]; then
    sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile || die "swapon failed -- see /swapfile above"
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  note "swap now: $(awk '/^SwapTotal:/{printf "%d MB", $2/1024}' /proc/meminfo)"
  # A small box should lean on swap only under real pressure.
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-xavage.conf >/dev/null
  sudo sysctl -q -w vm.swappiness=10
else
  note "memory: $((mem_kb/1024)) MB RAM, $((swap_kb/1024)) MB swap -- leaving as is"
fi

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
    # install_weak_deps=False and --nodocs hold this to the interpreter
    # itself rather than its recommended extras; clearing the cache after
    # gives back the repo metadata dnf just unpacked.
    sudo dnf install -y --setopt=install_weak_deps=False --setopt=keepcache=0 \
      --nodocs python3.11 python3.11-pip
    sudo dnf clean all >/dev/null 2>&1 || true
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y python3 python3-venv python3-pip
  else
    die "no dnf or apt-get; install Python 3.10+ manually and re-run"
  fi
  PY="$(find_python)" || die "still no Python 3.10+ after install"
fi
say "Using $($PY -c 'import sys,platform; print(platform.python_implementation(), sys.version.split()[0], "at", sys.executable)')"

# ------------------------------------------------------------------- install
# Two ways in. If a bundle built by build-bundle.sh sits next to this script,
# the dependencies are already here and nothing needs installing -- which is
# the whole point on a box where pip is enough to starve the machine.
BUNDLE_LIBS="$WORKER_DIR/libs"
if [ -f "$BUNDLE_LIBS/BUNDLE_INFO" ]; then
  say "Using the prebuilt bundle -- skipping pip entirely"
  sed 's/^/    /' "$BUNDLE_LIBS/BUNDLE_INFO"
  PY_EXEC="$(command -v "$PY")"
  RUN_ENV="PYTHONPATH=$BUNDLE_LIBS"
  export PYTHONPATH="$BUNDLE_LIBS"
else

# --only-binary=:all: refuses source builds outright. Every dependency
# publishes manylinux/aarch64 wheels, so this never needs gcc -- and if a
# wheel ever goes missing it fails in seconds instead of compiling numpy for
# half an hour on a shared core.
# --no-compile matters more than it looks: byte-compiling pandas and numpy is
# several thousand files and one of the heaviest steps of the install on a
# single shared core. Python writes the .pyc files lazily on first import
# instead, which costs one slow startup and nothing after that.
  say "No bundle found -- installing yfinance into $VENV with pip"
  note "on a 1 GB box prefer build-bundle.sh on your laptop; see DEPLOY-ORACLE.md"
  [ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
  # Non-fatal: a slightly old pip still installs every wheel we need.
  "$VENV/bin/python" -m pip install --quiet --disable-pip-version-check --upgrade pip || \
    note "pip self-upgrade skipped"
  # --no-compile matters more than it looks: byte-compiling pandas and numpy
  # is several thousand files and one of the heaviest steps of the install on
  # a single shared core. Python writes the .pyc files lazily on first import
  # instead, which costs one slow startup and nothing after that.
  "$VENV/bin/python" -m pip install --no-cache-dir --no-compile --disable-pip-version-check \
    --only-binary=:all: --upgrade -r "$WORKER_DIR/requirements.txt"
  note "$("$VENV/bin/python" -m pip list --disable-pip-version-check 2>/dev/null | tail -n +3 | wc -l) packages installed"
  PY_EXEC="$VENV/bin/python"
  RUN_ENV=""
fi

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
( cd "$WORKER_DIR" && "$PY_EXEC" poller.py --once ) \
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
ExecStart=$PY_EXEC -u poller.py
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
${RUN_ENV:+Environment=$RUN_ENV}
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
