# Running the price worker on Oracle Cloud (Always Free)

Oracle's **Always Free** tier doesn't expire, which suits a multi-week
competition better than trial credits. This walks through the console.

> Oracle changes the console layout regularly, so treat the labels below as
> "look for something like this" rather than exact text. The sequence is stable
> even when the wording moves.

---

## 1. Pick the shape you want

Always Free gives you **either** of these, and the ARM one is far more generous:

| Shape | Always Free allowance | Verdict for this worker |
| --- | --- | --- |
| **VM.Standard.A1.Flex** (Ampere, ARM) | 4 OCPU + 24 GB RAM total | **Use this.** 1 OCPU / 6 GB is plenty |
| VM.Standard.E2.1.Micro (AMD) | 2 instances, 1 OCPU + 1 GB each | Works, but 1 GB is tight with pandas |

The worker's dependencies are all ARM-clean — `python:3.12-slim` publishes
`linux/arm64`, and pandas, numpy and curl_cffi all ship `aarch64` wheels — so
nothing compiles from source on Ampere.

---

## 2. Create the instance

**Menu → Compute → Instances → Create instance**

| Field | Value |
| --- | --- |
| Name | `xavage-worker` |
| Image | **Ubuntu 24.04** (click *Change image* → Canonical Ubuntu) |
| Shape | *Change shape* → **Ampere** → `VM.Standard.A1.Flex` → **1 OCPU, 6 GB** |
| Networking | Leave defaults — it creates a VCN and assigns a public IPv4 |
| SSH keys | **Generate a key pair** and *download the private key* |

Look for the **"Always Free eligible"** badge on the shape. If it isn't there,
you're about to create something billable.

> **Save the private key somewhere permanent before leaving the page.** Oracle
> will not show it again, and without it you cannot get into the machine.

Click **Create** and wait for the state to go from `PROVISIONING` to
`RUNNING` (a minute or two). Copy the **Public IP address**.

### If you hit "Out of host capacity"

This is the single most common Always Free frustration — Ampere is heavily
oversubscribed in popular regions. In order of what actually works:

1. Change the **Availability Domain** (AD-1 / AD-2 / AD-3) and retry.
2. Ask for **less**: 1 OCPU / 6 GB is far likelier to land than 4 / 24.
3. Retry later — capacity frees up in waves, often off-peak for your region.
4. Fall back to **VM.Standard.E2.1.Micro** (AMD). It's only 1 GB, so add swap:
   ```bash
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

Your **home region is fixed at signup** and Always Free resources only exist
there, so you can't shop around regions for capacity.

---

## 3. Connect

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC_IP>
```

Ubuntu images use the `ubuntu` user. Oracle Linux uses `opc`.

---

## 4. Run the setup script

On the VM:

```bash
curl -fsSL -o setup.sh \
  https://raw.githubusercontent.com/BoredxInfinity/XAVAGE-STOCK-SIM/main/worker/setup-oracle.sh
bash setup.sh
```

Because the repo is private, `curl` above will 404. Either paste the script
contents into `nano setup.sh`, or clone first with a token — the script prompts
for one anyway.

It installs Docker, clones the repo, asks for your Supabase URL and
service-role key, builds the image, and starts the container with
`--restart unless-stopped` so it survives reboots.

It validates the key before writing it — pasting multiple variables into one
prompt is rejected up front rather than failing later as an unreadable
`Illegal header value`.

---

## 5. Confirm it's working

```bash
sudo docker logs -f --tail 30 xavage-worker
```

Healthy output:

```
PostgREST pinned to HTTP/1.1
cached 101 previous close(s)
cycle 1 | regular | 101 quotes | 48017 new bars | no fills | 152.68s
cycle 2 | regular | 101 quotes | 113 new bars | no fills | 6.06s
```

The first cycle is slow — it backfills all chart history. Then check
**Admin → Overview** in the app: it should read **"Price feed healthy"** with a
tick timestamp that keeps advancing.

---

## 6. Turn off Railway

Only once Oracle is confirmed healthy. Two workers running at once isn't
harmful — quote writes are idempotent upserts and `match_orders()` takes an
advisory lock, so no double-fills — but it doubles the load on Yahoo for
nothing.

Railway → your service → **Settings → Danger → Remove service**.

---

## Things worth knowing

**No inbound ports.** The worker only makes outbound connections. Leave the
security list alone — don't open 80/443. Less surface, nothing to configure.

**Idle reclamation.** Oracle may reclaim Always Free compute that sits idle
(very low CPU for ~7 days). This worker polls every 5 seconds during market
hours, so it won't qualify — but don't stop the container for a week and
expect the VM to still be there.

**Updating the worker later:**

```bash
cd ~/XAVAGE-STOCK-SIM && git pull
bash worker/setup-oracle.sh          # rebuilds and restarts
```

**Reading logs after reconnecting:**

```bash
sudo docker logs --tail 100 xavage-worker      # recent
sudo docker logs -f xavage-worker              # follow
sudo docker restart xavage-worker              # restart
```

Logs are capped at 3 × 10 MB so they can't fill the boot volume.
