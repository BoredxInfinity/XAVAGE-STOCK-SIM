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

# --------------------------------------------------------------- interpreter
# Oracle Linux 9 ships Python 3.9, which yfinance cannot use. Getting 3.11
# with dnf means the instance parses ~131 MB of uncompressed repo metadata
# into libsolv -- on 1 GB that is enough to starve the machine outright.
#
# The dependency closure is actually four packages totalling ~14 MB, and every
# shared library they need is already on the base image (python3.9 requires
# the same set). So resolve it here and ship the RPMs; the server just runs
# `rpm -Uvh`, which has no solver and no metadata to parse.
if [ "${SKIP_RPMS:-0}" = "1" ]; then
  say "SKIP_RPMS=1 -- not bundling an interpreter"
else
  say "Resolving python$PYDOT RPMs from Oracle's public repo"
  REPO=https://yum.oracle.com/repo/OracleLinux/OL9/appstream/x86_64
  mkdir -p "$STAGE/xavage-worker/rpms"

  curl -fsSL --max-time 60 "$REPO/repodata/repomd.xml" -o "$STAGE/repomd.xml"
  PRIMARY=$(python3 - "$STAGE/repomd.xml" <<'EOF'
import re, sys
s = open(sys.argv[1]).read()
for m in re.finditer(r'<data type="primary">.*?<location href="([^"]+)"', s, re.S):
    print(m.group(1)); break
EOF
)
  [ -n "$PRIMARY" ] || { echo "could not find primary.xml in repomd" >&2; exit 1; }
  curl -fsSL --max-time 300 "$REPO/$PRIMARY" -o "$STAGE/primary.xml.gz"

  python3 - "$STAGE/primary.xml.gz" "$REPO" "$STAGE/xavage-worker/rpms" <<'EOF'
import gzip, sys, urllib.request
import xml.etree.ElementTree as ET

path, repo, dest = sys.argv[1], sys.argv[2], sys.argv[3]
NS = {'c': 'http://linux.duke.edu/metadata/common'}
WANT = {"python3.11", "python3.11-libs", "python3.11-pip-wheel",
        "python3.11-setuptools-wheel"}
ARCH = {"x86_64", "noarch"}


def _seg(s):
    """Split an RPM version into comparable alternating digit/alpha runs."""
    out, cur, isdig = [], "", None
    for ch in s:
        if not ch.isalnum():
            if cur:
                out.append(cur); cur = ""; isdig = None
            continue
        d = ch.isdigit()
        if isdig is not None and d != isdig:
            out.append(cur); cur = ""
        cur += ch; isdig = d
    if cur:
        out.append(cur)
    return out


def vercmp(a, b):
    """rpmvercmp: digits beat letters, longer digit runs win numerically."""
    for x, y in zip(_seg(a), _seg(b)):
        xd, yd = x.isdigit(), y.isdigit()
        if xd != yd:
            return 1 if xd else -1
        if xd:
            x, y = x.lstrip("0") or "0", y.lstrip("0") or "0"
            if len(x) != len(y):
                return 1 if len(x) > len(y) else -1
        if x != y:
            return 1 if x > y else -1
    la, lb = len(_seg(a)), len(_seg(b))
    return (la > lb) - (la < lb)


best = {}
# The repo keeps every historical build, so take the newest EVR per name
# rather than whatever the parser happens to see last.
with gzip.open(path) as fh:
    for _, el in ET.iterparse(fh, events=("end",)):
        if el.tag != '{http://linux.duke.edu/metadata/common}package':
            continue
        name = el.findtext('c:name', namespaces=NS)
        arch = el.findtext('c:arch', namespaces=NS)
        if name in WANT and arch in ARCH:
            v = el.find('c:version', NS)
            evr = (v.get('ver'), v.get('rel'))
            loc = el.find('c:location', NS).get('href')
            prev = best.get(name)
            if prev is None or vercmp(evr[0], prev[0][0]) > 0 or (
                    evr[0] == prev[0][0] and vercmp(evr[1], prev[0][1]) > 0):
                best[name] = (evr, loc)
        el.clear()

missing = WANT - set(best)
if missing:
    sys.exit(f"could not resolve: {', '.join(sorted(missing))}")

total = 0
for name, ((ver, rel), loc) in sorted(best.items()):
    fn = loc.rsplit("/", 1)[-1]
    urllib.request.urlretrieve(f"{repo}/{loc}", f"{dest}/{fn}")
    import os
    total += os.path.getsize(f"{dest}/{fn}")
    print(f"    {name:30s} {ver}-{rel}")
print(f"    -> {total/1048576:.1f} MB of RPMs")
EOF
fi

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
