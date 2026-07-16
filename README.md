# lattice

A private 24/7 data pipeline: it enumerates on-chain liquidity-provider wallets,
computes per-wallet analytics (PnL, fees, win rate, position sizing, hold tempo,
range style, active session), and ranks them in a dashboard. Everything is derived
from real on-chain data and public APIs — no synthetic or placeholder values —
accumulated continuously over time.

Internal research tooling. Not affiliated with, or endorsed by, any protocol or
third-party service referenced in the code.

> **Handoff / status & next steps:** see [`CLAUDE.md`](CLAUDE.md) — current state,
> data model, key files, and the open TODO list.

## Architecture

Three processes, sharing one database (SQLite locally, Postgres-ready for a VPS):

```
┌ scraper/discover.py ─┐   OPTIONAL aggregator metrics   → Python + Scrapling
│  StealthySession     │   (Cloudflare-protected source) → writes wallets to DB
└──────────┬───────────┘
           │  data/lattice.sqlite  (the hand-off)
┌──────────┴───────────┐   ON-CHAIN (Node worker)        → census + enrich + analytics
│ packages/ingest      │   • census (hourly): ONE RPC     → EVERY wallet with an open
│  worker.ts           │     getProgramAccounts query        position (~88k in ~7s)
│                      │   • enrich: RPC + data API       → range, live PnL, session
│                      │   • analytics: full lifetime     → win rate, avg inv/age, PnL
└──────────┬───────────┘
┌──────────┴───────────┐
│ packages/web (Next)  │   dashboard @ :3737             → USD/SOL, 12h/24h/7d…
└──────────────────────┘
```

**Discovery is solved by the census** — one `getProgramAccounts` call (filtered to
position accounts, reading each owner) enumerates the entire LP universe in seconds.
The ongoing work is **enrichment**: computing each wallet's analytics incrementally.

**Why the split:** lpagent/fabriq are behind Cloudflare. Scrapling's
`StealthySession(solve_cloudflare=True)` passes Turnstile reliably with built-in
retries/proxy rotation — far more stable than driving Camoufox by hand. The
Cloudflare-hard discovery lives in Python; the on-chain enrichment + UI stay Node.
(A Node Camoufox driver still exists at `packages/ingest/src/adapters/camoufox.ts`
as a fallback, but Scrapling is the recommended path.)

## Data model — which number is which

- **Fees earned** (lpagent, SOL → USD): the big cumulative number — e.g. 202 SOL ≈
  **$15k+**. Shown in the `FEES` column. This is usually the "tens of thousands".
- **Profit 7d / 30d / all** (lpagent): real per-window cumulative PnL, in SOL.
  These are genuinely different windows because lpagent computes them; the `all`
  column is lifetime.
- **12h / 24h**: DELTAS from **our own** scrape snapshots (`wallet_history`). They
  are empty until the worker/scraper has taken ≥2 snapshots that far apart — no
  estimated/dummy values. This is the "latest snapshot" model.
- **Live PnL** (Meteora datapi): current open-position PnL. Small by nature.
- **Deep PnL** (`getWalletDeepPnl`): lifetime PnL summed across ALL positions
  (open + closed) in ALL historical pools. Heavy (pools × pages) — run for ranked
  candidates, deepen `historyPages` for accuracy.

## Install — personal (Windows / macOS)

Prereqs: **Node 20+** and **Python 3.10+**.

```bash
git clone <repo> && cd lattice
npm install                              # Node side (uses built-in node:sqlite)
npm run db:seed                          # 36 real sample wallets so the UI renders
npm run web                              # dashboard at http://localhost:3737

python -m venv .venv
# Windows:  .venv\Scripts\activate      macOS: source .venv/bin/activate
pip install -r scraper/requirements.txt
scrapling install                        # one-time: fetch the stealth browser
```

Create `.env` in the repo root (gitignored):

```
SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
HELIUS_API_KEY=YOUR_HELIUS_KEY
METEORA_DATAPI=https://dlmm.datapi.meteora.ag
```

Run the pipeline manually:

```bash
python scraper/discover.py --pages 30                                   # discover
node --env-file=.env node_modules/.bin/tsx packages/ingest/src/enrich.ts # enrich
```

## Install — VPS (Ubuntu/Debian Linux)

```bash
sudo apt update && sudo apt install -y nodejs npm python3 python3-venv python3-pip git
# (or install Node 20+ via nvm / nodesource for a current version)

git clone <repo> && cd lattice
npm install && npm run db:seed
python3 -m venv .venv && source .venv/bin/activate
pip install -r scraper/requirements.txt
scrapling install                        # downloads the headless stealth browser
# create .env as above
```

Run the three processes as **systemd** services so they survive reboots. Example
`/etc/systemd/system/lattice-web.service`:

```ini
[Unit]
Description=lattice web
After=network.target
[Service]
WorkingDirectory=/opt/lattice
ExecStart=/usr/bin/npm run web
Restart=always
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
```

`lattice-worker.service` → `ExecStart=/usr/bin/node --env-file=.env node_modules/.bin/tsx packages/ingest/src/worker.ts`.
For the scraper, either run it inside the worker cadence or as a **cron/timer**
(every few hours, matching the snapshot interval):

```cron
0 */3 * * * cd /opt/lattice && .venv/bin/python scraper/discover.py --pages 30 >> /var/log/lattice-scrape.log 2>&1
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lattice-web lattice-worker
```

## Making it reachable from outside the VPS (no Vercel)

This is a live Node server + worker, so Vercel (static/serverless) doesn't fit. Pick one:

**A. Cloudflare Tunnel (easiest, free, no open ports)** — great even behind NAT:

```bash
# install cloudflared, then:
cloudflared tunnel login
cloudflared tunnel create lattice
cloudflared tunnel route dns lattice lattice.yourdomain.com
cloudflared tunnel run --url http://localhost:3737 lattice
```

Gives a public HTTPS URL (`lattice.yourdomain.com`) mapped to your local `:3737`, TLS
handled by Cloudflare. Run it as a service (`cloudflared service install`).

**B. nginx reverse proxy + domain + Let's Encrypt** (classic VPS with a public IP):

```nginx
server {
  server_name lattice.yourdomain.com;
  location / { proxy_pass http://127.0.0.1:3737; proxy_set_header Host $host; }
}
```

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d lattice.yourdomain.com
```

**C. Tailscale** — private access from your own devices only (no public exposure).

## Config

`.env` (see above) overrides everything. Hardcoded defaults you can edit directly
at the top of `packages/ingest/src/worker.ts`:

```ts
const DEFAULT_INTERVAL_MS = 5 * 60_000;  // pass interval
const DEFAULT_DISCOVER_PAGES = 5;        // activity-stream pages per pass
const DEFAULT_ENRICH_PER_PASS = 30;      // light enrichments per pass
const DEFAULT_DEEP_PER_PASS = 3;         // full analytics per pass (heavy)
const DEFAULT_DEEP_HISTORY_PAGES = 60;   // history depth for the analytics pass
```

Range thresholds (bin step): `BIN_STEP_BANDS` in `packages/core/src/classify.ts`.

## Cadence & scale

The census (hourly) makes the wallet set complete immediately — **enrichment is the
long pole**: each wallet's analytics needs a history walk + position pagination
(~1–2 min), so ~88k wallets fill in incrementally over days. Tune `DEEP_PER_PASS` /
`DEEP_HISTORY_PAGES` against your RPC credit budget — that, not the code, is the
real constraint. Run extra `analytics-enrich --limit N --order new` passes to speed
it up. The 12h/24h columns are deltas from our own snapshots, so they populate only
after the worker has been running that long.
