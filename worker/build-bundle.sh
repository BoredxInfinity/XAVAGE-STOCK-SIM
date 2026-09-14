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
  say "Resolving python$PYDOT RPMs from Oracle's public repos"
  mkdir -p "$STAGE/xavage-worker/rpms"

  python3 - "$STAGE/xavage-worker/rpms" <<'EOF'
import gzip, io, os, re, subprocess, sys, tempfile
import xml.etree.ElementTree as ET

dest = sys.argv[1]
NS = {'c': 'http://linux.duke.edu/metadata/common'}
# AppStream only, and deliberately. Every package in the closure below is in
# it -- including libnsl2 and mpdecimal, which live in BaseOS on stock RHEL.
# Adding baseos/latest as a second source costs a 134 MB primary.xml.gz
# (it carries every historical build since OL9 GA) against AppStream's 8 MB,
# which turns a fast build into a very long one for no packages gained.
REPOS = ["https://yum.oracle.com/repo/OracleLinux/OL9/appstream/x86_64"]

# The dependency closure, established from what `rpm -Uvh` actually rejected
# on a real OL9 instance rather than assumed. The base image's python3.9
# covers most of python3.11's shared libraries, but not these two: RHEL 9's
# python3.9 bundles its own _decimal where python3.11 links the system
# mpdecimal (libmpdec.so.3), and nothing in the base set provides
# libnsl.so.3. Everything else python3.11-libs wants -- openssl, sqlite,
# gdbm, tirpc, ncurses, readline, uuid, expat, ffi, lzma, bz2, zlib -- is
# already there, which rpm confirmed by not complaining about them.
WANT = {"python3.11", "python3.11-libs", "python3.11-pip-wheel",
        "python3.11-setuptools-wheel", "mpdecimal", "libnsl2"}
ARCH = {"x86_64", "noarch"}


def fetch(url, dest=None, timeout=300):
    """Download with curl, not urllib.

    Measured against yum.oracle.com on the same machine in the same second:
    curl 5.6 MB/s, urllib 0.06 MB/s -- a ~90x difference that turns an 8 MB
    index into a multi-minute wait and looks exactly like a hang. The cause
    is somewhere in urllib's connection setup and not worth chasing; curl
    ships with every macOS and Linux host this script runs on.
    """
    out = dest or os.path.join(tempfile.gettempdir(), "xavage-fetch.tmp")
    subprocess.run(
        ["curl", "-fsSL", "--max-time", str(timeout), "-o", out, url],
        check=True,
    )
    if dest:
        return None
    with open(out, "rb") as fh:
        data = fh.read()
    os.unlink(out)
    return data


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


def newer(evr, prev):
    if prev is None:
        return True
    c = vercmp(evr[0], prev[0])
    return c > 0 or (c == 0 and vercmp(evr[1], prev[1]) > 0)


best = {}
for repo in REPOS:
    md = fetch(f"{repo}/repodata/repomd.xml", timeout=60).decode()
    m = re.search(r'<data type="primary">.*?<location href="([^"]+)"', md, re.S)
    if not m:
        sys.exit(f"no primary.xml in {repo}")
    raw = fetch(f"{repo}/{m.group(1)}")
    # The repo keeps every historical build, so take the newest EVR per name
    # rather than whatever the parser happens to see last.
    with gzip.open(io.BytesIO(raw)) as fh:
        for _, el in ET.iterparse(fh, events=("end",)):
            if el.tag != '{http://linux.duke.edu/metadata/common}package':
                continue
            name = el.findtext('c:name', namespaces=NS)
            if name in WANT and el.findtext('c:arch', namespaces=NS) in ARCH:
                v = el.find('c:version', NS)
                evr = (v.get('ver'), v.get('rel'))
                prev = best.get(name)
                if newer(evr, prev[0] if prev else None):
                    best[name] = (evr, f"{repo}/{el.find('c:location', NS).get('href')}")
            el.clear()

missing = WANT - set(best)
if missing:
    sys.exit(f"could not resolve: {', '.join(sorted(missing))}")

total = 0
for name, ((ver, rel), url) in sorted(best.items()):
    fn = url.rsplit("/", 1)[-1]
    fetch(url, dest=f"{dest}/{fn}")
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
# Every .py in worker/, not a hand-maintained list. The list drifted once
# already -- logbook.py was added to the worker and never added here, so the
# bundle shipped a poller.py whose very first import could not resolve, and
# setup.sh only found out when it ran --check on the box mid-install.
for f in "$WORKER_DIR"/*.py; do
  cp "$f" "$STAGE/xavage-worker/"
done
for f in requirements.txt setup.sh .env.example; do
  cp "$WORKER_DIR/$f" "$STAGE/xavage-worker/"
done

say "Verifying every local import resolves inside the bundle"
# A real `import poller` cannot run here: libs/ holds linux wheels and this
# script builds on a mac. So check it statically instead -- walk the staged
# sources, collect every module they import, and assert that anything not
# satisfied by requirements.txt or the stdlib is a file we actually shipped.
python3 - "$STAGE/xavage-worker" <<'PYEOF'
import ast, pathlib, sys

stage = pathlib.Path(sys.argv[1])
local = {p.stem for p in stage.glob("*.py")}
missing = []

for src in sorted(stage.glob("*.py")):
    tree = ast.parse(src.read_text(), filename=str(src))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [a.name.split(".")[0] for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            # level > 0 is a relative import; the worker has none, but be safe.
            names = [node.module.split(".")[0]] if node.level == 0 and node.module else []
        else:
            continue
        for name in names:
            if name in local or name in sys.stdlib_module_names:
                continue
            # Third-party: yfinance and whatever it drags in, all vendored
            # into libs/. Anything else unresolved is a packaging bug.
            if (stage / "libs" / name).exists() or list((stage / "libs").glob(name + "-*.dist-info")):
                continue
            missing.append(f"{src.name}: {name}")

if missing:
    print("ERROR: imports that resolve to nothing in the bundle:", file=sys.stderr)
    for m in sorted(set(missing)):
        print("  " + m, file=sys.stderr)
    sys.exit(1)
print(f"  {len(local)} local module(s), all imports resolve")
PYEOF

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
