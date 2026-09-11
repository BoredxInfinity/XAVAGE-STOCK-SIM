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
| Capacity type | **On-demand capacity** — see below |
| Networking | Leave defaults — it creates a VCN and assigns a public IPv4 |
| SSH keys | **Generate a key pair** and *download the private key* |

Look for the **"Always Free eligible"** badge on the shape. If it isn't there,
you're about to create something billable.

**Capacity type** lives under *Placement*, sometimes behind "Show advanced
options". Leave it on **On-demand capacity**: it is the default, and the only
one Always Free applies to. *Preemptible capacity* is cheaper but Oracle
reclaims it with about 30 seconds' notice, which is fatal for a worker that has
to stay up for the length of a competition. *Capacity reservation* needs a
reservation you have already paid for.

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

On 1 GB, **build the dependencies on your laptop and upload them.** Running
`pip` on the instance is enough to starve the machine — numpy and pandas have
to be resolved and unpacked, and the box has no headroom for it. Doing that
work where memory is free means the server runs no pip, no venv, no dependency
resolver and no package download at all.

### On your laptop

```bash
cd ~/path/to/XAVAGE-STOCK-SIM
bash worker/build-bundle.sh
scp -i ~/Downloads/ssh-key-*.key xavage-worker-bundle.tar.gz opc@<PUBLIC_IP>:~
```

That produces a **~56 MB** tarball holding the worker, all 23 Python
dependencies cross-built for Linux x86_64 / CPython 3.11, and the four RPMs
for the interpreter itself. Building on an ARM Mac is fine:
`pip` is told to resolve for the target platform, and nothing is executed, only
unpacked.

### On the instance

```bash
tar xzf xavage-worker-bundle.tar.gz
bash xavage-worker/setup.sh
```

`setup.sh` finds the bundled `libs/` and `rpms/` and downloads nothing. It:

1. adds a 2 GB swapfile **before** anything else allocates
2. installs Python 3.11 from the bundled RPMs with `rpm -Uvh` — no `dnf`, no
   repo metadata (skipped entirely if a 3.10+ interpreter already exists)
3. asks for your Supabase URL and service-role key (input hidden)
4. **runs one real cycle** and stops if it fails
5. installs and starts the `xavage-worker` systemd service, pointing
   `PYTHONPATH` at the bundled `libs/`

No pip, no venv, no dependency resolver and no package downloads run on the
instance at any point.

Everything it does is logged to `~/xavage-setup.log`, line by line. If the box
locks up and you have to reboot it from the console, that file tells you which
phase it died in.

### Updating later

Rebuild and re-upload the bundle, or — if only the Python source changed and
no dependency did — copy just the five files:

```bash
scp -i <key> worker/{poller,feed,db,config,market}.py opc@<IP>:~/xavage-worker/
ssh -i <key> opc@<IP> 'sudo systemctl restart xavage-worker'
```

That is a ~60 KB upload and needs nothing installed on either end.

---

## 3b. Why the instance was freezing

`dnf install python3.11` was the step that took the box down, and it is worth
knowing why, because the fix follows from it.

Oracle Linux 9 ships Python **3.9** as `/usr/bin/python3`, and yfinance cannot
run on it — `curl_cffi` declares `Requires-Python >=3.10`. So an interpreter
has to come from somewhere. But asking `dnf` for it means the instance
downloads the AppStream repo index and parses it into libsolv: **~131 MB of
XML uncompressed, from one repo**, before it has decided to install anything.
On 1 GB that is enough to starve the machine until it stops answering —
including the OCI monitoring agent, which is why the console goes blank on CPU
and memory rather than showing a spike.

The actual dependency closure is **four packages, 14 MB**:

| Package | Size |
| --- | --- |
| `python3.11` | 32 KB |
| `python3.11-libs` | 12 MB |
| `python3.11-pip-wheel` | 1.4 MB |
| `python3.11-setuptools-wheel` | 716 KB |

Every shared library they need — openssl, libffi, sqlite, ncurses, readline,
libmpdec, tzdata — is already on the base image, because the bundled Python 3.9
requires the same set.

So `build-bundle.sh` resolves that closure against Oracle's public repo *on
your laptop* and ships the four RPMs inside the bundle. On the instance,
`setup.sh` installs them with:

```
rpm -Uvh rpms/*.rpm
```

`rpm` installs exactly what it is handed. No solver, no repo metadata, no
network. That is the whole difference between an install that finishes in
seconds and one that hangs the machine.

`dnf` is still there as a fallback if you run `setup.sh` without a bundle, and
it warns you first.

### If it froze and the console shows no metrics

That is the box being starved, not a crash — the monitoring agent stops
reporting because it is starved too. Recover with **Instance details → Reboot**
in the console (a hard reset, since it will not shut down cleanly), then:

```bash
cat ~/xavage-setup.log          # which phase it died in
free -m                         # is swap actually on?
dmesg -T | grep -i 'killed process'
```

If `free -m` shows `Swap: 0`, add it before anything else. Use `dd`, **not**
`fallocate` — OCI boot volumes are XFS, where fallocate produces extents that
`swapon` rejects:

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -m
```

Swap is insurance, not the fix — with the bundle, nothing in the install
should come close to needing it.

### Would a custom image help?

Probably not, and it does not avoid the work — it only moves it. You still have
to do the install once, somewhere, and then you are maintaining an image.

If you want one anyway, the easy route is **not** building an image locally and
importing it (that path wants qcow2/VMDK conversion, cloud-init, virtio drivers
and an Object Storage upload). Instead, set one instance up normally and
capture it: **Instance details → More actions → Create custom image**. OCI
stops the instance, snapshots the boot volume, and every future instance you
launch from that image already has Python, the venv and the service on it.
Check the console for what the stored image costs against your tenancy before
relying on it.

The honest comparison: with swap in place, `dnf install python3.11` is a
one-off couple of minutes. A custom image is worth it if you expect to rebuild
this machine repeatedly, and not otherwise.

### Keeping setup alive when you disconnect

With the bundle there is nothing to download and the script finishes in well
under a minute, so this matters far less than it used to. The one slow step is
the first cycle's chart backfill, and that happens under systemd rather than in
your shell.

If you still want it detached — say you are doing the `dnf` step by hand over a
flaky link:

```bash
 SUPABASE_URL='https://<ref>.supabase.co' \
 SUPABASE_SERVICE_ROLE_KEY='eyJ...' \
   nohup bash ~/xavage-worker/setup.sh > /dev/null 2>&1 &
```

Either way the script tees everything to `~/xavage-setup.log`, so you can
reconnect and `tail -f` it. Once it finishes none of this matters — systemd
owns the process and restarts it on boot.

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
# update the worker source (see "Updating later" above for the scp command)
sudo systemctl restart xavage-worker

# logs
journalctl -u xavage-worker -f              # follow
journalctl -u xavage-worker -n 100          # recent
journalctl -u xavage-worker -p warning      # only things that went wrong

# control
sudo systemctl restart xavage-worker
sudo systemctl stop xavage-worker
```

If an update brings a new dependency (it rarely will), rebuild the bundle on
your laptop and re-upload it, then re-run `setup.sh`.

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
