# Running the price worker on Oracle Cloud (Always Free)

Target: **VM.Standard.E2.1.Micro**, Oracle Linux, 1 OCPU / 1 GB RAM, free
forever. The worker is sized for exactly that box — one dependency, no Docker,
no compiler, no third-party repos. Setup is a clone and one script; every
update after that is `git pull` and a restart.

---

## What it costs to run

Measured against a 105-symbol universe:

| | |
| --- | --- |
| Packages installed | **23** (`yfinance` and its own requirements) |
| Download size | ~48 MB of wheels |
| Resident memory, steady state | **~260 MB** |
| Cycle time, steady state | **~4 s**, almost all of it waiting on Yahoo |
| Rows written per cycle | ~105 quotes + ~105 bars |

The first cycle is the outlier: it backfills the whole chart history (~52k
minute bars plus ~107k longer-range bars) and takes a few minutes. Every cycle
after that only sends what the database has not already seen.

---

## 1. Create the instance

**Menu → Compute → Instances → Create instance**

| Field | Value |
| --- | --- |
| Name | `xavage-worker` |
| Image | **Oracle Linux 9** (the default) |
| Shape | *Change shape* → **AMD** → `VM.Standard.E2.1.Micro` |
| Networking | Leave defaults — it creates a VCN and assigns a public IPv4 |
| SSH keys | **Generate a key pair** and *download the private key* |

Look for the **"Always Free eligible"** badge on the shape. If it isn't there,
you're about to create something billable.

> **Save the private key before leaving the page.** Oracle will not show it
> again, and without it you cannot get into the machine.

The Ampere shape (`VM.Standard.A1.Flex`, 4 OCPU / 24 GB) is also Always Free
and works identically — every dependency publishes `aarch64` wheels. It is just
far more likely to be out of capacity. The E2.1.Micro is almost always
available, and this worker fits in it.

---

## 2. Connect

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key opc@<PUBLIC_IP>
```

`opc` is the Oracle Linux login. (It's `ubuntu` on an Ubuntu image; the setup
script handles either distro.)

---

## 3. Install

The repo is private, so clone it with a GitHub personal access token that has
`repo` scope. Start the line with a **space** so the token stays out of your
shell history.

```bash
 git clone https://<YOUR_TOKEN>@github.com/BoredxInfinity/XAVAGE-STOCK-SIM.git ~/XAVAGE-STOCK-SIM
```

Then:

```bash
bash ~/XAVAGE-STOCK-SIM/worker/setup.sh
```

It asks for your Supabase URL and service-role key (input hidden), and does
everything else:

1. finds a Python 3.10+ interpreter, installing `python3.11` from Oracle
   Linux's **own AppStream repo** if there isn't one — see the note below
2. adds a 2 GB swapfile, since 1 GB with none is asking for an OOM kill
3. creates a venv in `~/.xavage-venv` and installs `yfinance`
4. writes `worker/.env` with mode `0600`
5. **runs one real cycle** and stops if it fails, so a bad key or a blocked
   egress path shows up right here instead of in a restart loop
6. installs and starts a `xavage-worker` systemd service

Re-running it is safe — it's also the upgrade path.

### Why it installs python3.11

Oracle Linux 9 ships Python **3.9** as `/usr/bin/python3`, and yfinance cannot
run on it: `curl_cffi` declares `Requires-Python >=3.10` and pandas 3 wants
`>=3.11`. `python3.11` is a stock AppStream RPM — the same repo the base image
already trusts, a prebuilt binary, about 15 seconds. Nothing is compiled and
no repo is added. If the image already has 3.10+, the script uses that and
installs nothing.

### Keeping setup alive when you disconnect

The install takes a few minutes and dies with your SSH session.

```bash
sudo dnf install -y tmux
tmux new -s setup
bash ~/XAVAGE-STOCK-SIM/worker/setup.sh
```

`Ctrl-B` then `D` detaches; `tmux attach -t setup` picks it back up.

Or run it fully unattended:

```bash
 SUPABASE_URL='https://<ref>.supabase.co' \
 SUPABASE_SERVICE_ROLE_KEY='eyJ...' \
   nohup bash ~/XAVAGE-STOCK-SIM/worker/setup.sh > ~/setup.log 2>&1 &
```

Once it finishes none of this matters — systemd owns the process and restarts
it on boot.

---

## 4. Confirm it's working

```bash
journalctl -u xavage-worker -f
```

Healthy output:

```
cached 105 previous close(s)
cycle 1 | closed (idle, mode=regular) | 105 quotes | 52411 new bars | no fills | 229.27s
cycle 2 | closed (idle, mode=regular) | 105 quotes | 105 new bars | no fills | 5.78s
cycle 3 | regular | 105 quotes | 105 new bars | 2 fill(s) | 4.22s
```

Cycle 1 is the one-time backfill. From cycle 2 on, "105 new bars" is each
symbol's still-forming current candle being rewritten, which is what keeps the
last point on a live chart moving.

Then check **Admin → Overview** in the app: it should read **"Price feed
healthy"** with a tick timestamp that keeps advancing.

Memory, if you want to watch it:

```bash
systemctl show xavage-worker -p MemoryCurrent    # bytes
free -m
```

---

## 5. Day-to-day

```bash
# update to the latest code
cd ~/XAVAGE-STOCK-SIM && git pull && sudo systemctl restart xavage-worker

# logs
journalctl -u xavage-worker -f              # follow
journalctl -u xavage-worker -n 100          # recent
journalctl -u xavage-worker -p warning      # only things that went wrong

# control
sudo systemctl restart xavage-worker
sudo systemctl stop xavage-worker
```

If `git pull` brings a new dependency (it won't, often), re-run
`bash worker/setup.sh` instead of just restarting.

To test a change without disturbing the service:

```bash
sudo systemctl stop xavage-worker
cd ~/XAVAGE-STOCK-SIM/worker && ~/.xavage-venv/bin/python poller.py --once
sudo systemctl start xavage-worker
```

---

## Things worth knowing

**No inbound ports.** The worker only makes outbound connections. Leave the
security list alone — don't open 80/443. Less surface, nothing to configure.

**Memory limits are set deliberately.** The unit sets `MemoryHigh=600M` and
`MemoryMax=800M`, so if the worker ever leaks it gets throttled and then killed
and restarted, rather than taking the whole box down with it. Steady state is
~260 MB, so there is a lot of headroom.

**Journal size.** systemd caps the journal at 10% of `/var/log` by default,
which is fine on a 47 GB boot volume. If you want it smaller:
`sudo journalctl --vacuum-size=200M`.

**Idle reclamation.** Oracle may reclaim Always Free compute that sits idle
(very low CPU for ~7 days). This worker polls every 5 seconds during market
hours, so it won't qualify — but don't stop it for a week and expect the VM to
still be there.

**Two workers at once is safe.** Quote writes are idempotent upserts and
`match_orders()` takes a transaction-level advisory lock, so running this
alongside the Vercel cron fallback can't double-fill. It just doubles the load
on Yahoo for nothing, so turn the other one off once this is healthy.
