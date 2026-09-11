#!/usr/bin/env bash
#
# Build a self-contained worker bundle ON YOUR LAPTOP, for a Linux x86_64 box.
#
# The 1 GB E2.1.Micro cannot comfortably run pip: resolving and unpacking
# numpy and pandas is enough to starve the whole machine. So do it here, where
# memory is free, and ship the result. The server then needs no pip, no venv,
# no resolver and no network -- just tar.
#
#   bash worker/build-bundle.sh
#   scp -i <key> xavage-worker-bundle.tar.gz opc@<IP>:~
#
# On the box:
#   tar xzf xavage-worker-bundle.tar.gz && bash xavage-worker/setup.sh
set -euo pipefail

WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$PWD/xavage-worker-bundle.tar.gz}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Must match the interpreter on the server. Oracle Linux 9's AppStream
# python3.11 is the target; change both if you move to another.
PYVER=311
PYDOT=3.11

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }

say "Cross-building Linux x86_64 / cp$PYVER wheels"
# --platform + --only-binary=:all: makes pip resolve for the TARGET machine
# rather than this one, so an arm64 Mac produces a manylinux x86_64 tree.
# Nothing is executed, only unpacked, so cross-building is safe.
python3 -m pip install \
  --quiet --disable-pip-version-check \
  --target "$STAGE/xavage-worker/libs" \
  --platform manylinux_2_28_x86_64 \
  --platform manylinux2014_x86_64 \
  --python-version "$PYDOT" \
  --implementation cp \
  --abi "cp$PYVER" \
  --only-binary=:all: \
  --no-compile \
  -r "$WORKER_DIR/requirements.txt"

say "Trimming test suites"
# numpy and pandas ship their own test suites, which nothing imports at
# runtime. Dropping them roughly halves the upload.
find "$STAGE/xavage-worker/libs" -type d -name tests -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE/xavage-worker/libs" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

say "Adding worker source"
for f in poller.py feed.py db.py config.py market.py requirements.txt setup.sh .env.example; do
  cp "$WORKER_DIR/$f" "$STAGE/xavage-worker/"
done

# A marker setup.sh looks for, so it knows to skip pip entirely.
cat > "$STAGE/xavage-worker/libs/BUNDLE_INFO" <<EOF
built:    $(date -u +%FT%TZ)
target:   linux x86_64, CPython $PYDOT
packages: $(find "$STAGE/xavage-worker/libs" -maxdepth 1 -name '*.dist-info' | wc -l | tr -d ' ')
EOF

say "Checking nothing host-specific leaked in"
# Scoped to actual binaries: a bare *win*/*darwin* glob would match innocent
# things like pandas/core/window and pytz's Australia/Darwin timezone.
leaked=$(find "$STAGE/xavage-worker/libs" \
  \( -name '*.dylib' \) -o \
  \( -name '*.so' -a \( -name '*darwin*' -o -name '*macosx*' \) \) -o \
  \( -name '*.pyd' \) )
if [ -n "$leaked" ]; then
  echo "ERROR: host-native artifacts in the bundle:" >&2
  echo "$leaked" >&2
  exit 1
fi
find "$STAGE/xavage-worker/libs" -name '*.so' | head -3 | while read -r so; do
  printf '    %s\n' "${so#$STAGE/xavage-worker/libs/}"
done

tar czf "$OUT" -C "$STAGE" xavage-worker
say "Bundle ready"
printf '    %s\n    %s\n' "$OUT" "$(du -h "$OUT" | cut -f1) — $(find "$STAGE/xavage-worker/libs" -maxdepth 1 -name '*.dist-info' | wc -l | tr -d ' ') packages"
