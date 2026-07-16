# Deploy lattice on a VPS (24/7)

Assumes the repo at `/opt/lattice`, Node 20+ and Python 3.10+ installed, and a
`.env` in the repo root (SOLANA_RPC / HELIUS_API_KEY / METEORA_DATAPI).

## 1. Build

```bash
cd /opt/lattice
npm install
npm run build -w @lattice/web           # production Next build
python3 -m venv .venv && . .venv/bin/activate
pip install -r scraper/requirements.txt
scrapling install                        # stealth browser for the scraper
```

## 2. Services (systemd)

```bash
sudo cp deploy/lattice-worker.service /etc/systemd/system/
sudo cp deploy/lattice-web.service    /etc/systemd/system/
sudo cp deploy/lattice-scraper.service /etc/systemd/system/
sudo cp deploy/lattice-scraper.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lattice-worker lattice-web lattice-scraper.timer
# check:
systemctl status lattice-worker
journalctl -u lattice-worker -f
```

- **worker** — each pass: hourly **wallet census** (one getProgramAccounts query →
  every wallet with an open DLMM position, ~88k in seconds) + light activity stream,
  then **enrich** (range/PnL/session) and **deep analytics** for a slice. Restarts on crash.
- **web** — dashboard on :3737.
- **scraper.timer** — lpagent Scrapling scrape every 3h (optional; adds lpagent metrics).

The census makes discovery instant/complete — **the ongoing work is enrichment**:
~88k wallets each need their on-chain analytics computed (win rate, avg invested,
avg age, lifetime PnL…). The worker grinds through them incrementally. To speed it
up (watch Helius credits), run extra passes manually:

```bash
# full wallet census on demand
node --env-file=.env node_modules/.bin/tsx packages/ingest/src/discover-all.ts
# analytics for N wallets (--order new = never-analysed first)
node --env-file=.env node_modules/.bin/tsx packages/ingest/src/analytics-enrich.ts --limit 200 --order new
```

## 3. Public URL (no Vercel)

**Cloudflare Tunnel** (recommended — free, no open ports):

```bash
cloudflared tunnel login
cloudflared tunnel create lattice
cloudflared tunnel route dns lattice lattice.yourdomain.com
cp deploy/cloudflared-config.yml ~/.cloudflared/config.yml   # edit UUID + hostname
cloudflared service install
```

Or **nginx + certbot** if the VPS has a public IP (see the root `README.md`).

## Database

SQLite (`data/lattice.sqlite`) is fine to start — WAL + `busy_timeout` let the Python
scraper and Node worker write concurrently. It handles millions of rows. Move to
**Postgres** only when you need multiple concurrent writers or cross-machine access:
the DB access is isolated to `packages/db/src/index.ts` (Node) and the `upsert`/query
helpers in `scraper/discover.py` (Python) — reimplement those against `pg` and point
`LATTICE_DB` at the Postgres URL; callers don't change.

## Notes

- Watch Helius credit usage — deep-enrich is the heavy consumer. Tune `DEEP_PER_PASS`
  / `DEEP_HISTORY_PAGES` (worker env) and the `deep-enrich --limit`.
- Use a residential proxy in Scrapling if the VPS datacenter IP draws extra Cloudflare
  challenges.
