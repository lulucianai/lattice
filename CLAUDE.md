# lattice — Claude handoff guide

> Read **Current status** before continuing. Full install/run details: `README.md`.

---

## Project

| Item | Value |
|------|-------|
| Name | **lattice** (codename) — tracker for top Meteora DLMM LP wallets |
| Path | `D:\codevibe\topdlmm` (local folder still has the old name; **project/repo = `lattice`**) |
| Repo | https://github.com/lulucianai/lattice (**public**) |
| Goal | Enumerate every active Meteora DLMM LP wallet → complete, real per-wallet dataset (PnL, fees, playstyle) → leaderboard. Modeled on the user's friend's tool (42k-wallet header + playstyle leaderboard). For research. |
| Concept refs | friend's dashboard (screenshots), `bengbeng.app` (full-history PnL for ONE wallet on demand — we do it automatically, en masse) |
| Principle | **ZERO dummy data** — real scrape + on-chain + normalization, accumulated 24/7 |

**Opsec:** name / README / page title are neutral (no protocol keywords) and the app
sends `robots: noindex`. **BUT** the code necessarily contains `dlmm.datapi.meteora.ag`,
the DLMM program id, and `app.lpagent.io` — on a **public** repo GitHub code-search
will still find it. Real protection = private repo. The user chose public + codename
after being told this.

Stack: **Node/TS monorepo (npm workspaces) + Python scraper (Scrapling)**, DB via
`node:sqlite` (Postgres-ready). Node 20+, Python 3.10+.

## Architecture (3 processes, 1 DB `data/lattice.sqlite`)

```
Python/Scrapling  scraper/discover.py       → OPTIONAL lpagent metrics (Cloudflare-hard)
Node worker       packages/ingest/worker.ts → census + enrich + deep analytics
Next.js           packages/web              → dashboard :3737
```

## Data sources (all endpoints verified)

| Source | Used for | Notes |
|--------|----------|-------|
| **Helius RPC** `mainnet.helius-rpc.com` (key in `.env`) | `getProgramAccounts` census, per-wallet open positions, `getSignaturesForAddress`, `/v0/transactions` batch-parse | Public RPCs BLOCK gPA; Helius allows it. **The credit budget is the real constraint.** |
| **Meteora datapi** `dlmm.datapi.meteora.ag` | `/positions/{pool}/pnl?user=` → paginated positions w/ `pnlUsd/Sol`, `allTimeDeposits`, `createdAt/closedAt`, bin range. `/pools/{pool}` → `pool_config.bin_step`. `/pools?page=N` → 119k pools (10/page, ignores `limit`) | JSON, CORS-open, no Cloudflare. No wallet→positions endpoint. **Money values unreliable for some pools — see Known issues.** |
| lpagent `app.lpagent.io/smart-lp?page=N` | optional curated metrics (~309 wallets) | RSC + Cloudflare → Scrapling only |
| **Jupiter** `lite-api.jup.ag` | `/price/v3?ids=` token prices, `/tokens/v2/search` metadata | For the pending revaluation fix |
| CoinGecko | live SOL price (USD toggle) | `web/src/lib/price.ts`, 60s cache + fallback |

### Key on-chain constants
- DLMM program: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
- `PositionV2` discriminator: `75b0d4c7f5b485b6` · layout `disc(8) | lbPair(32) | owner(32)`
- `LbPair` (pool) discriminator: `210b3162b565b10d`

## The tiered enrichment funnel (core design)

Deep-analysing all 88k wallets would take **~91 days and ~17M Helius calls** — hence tiers:

| Tier | What | Cost | Runner |
|------|------|------|--------|
| **1 — census** | ONE `getProgramAccounts` (dataSlice offset 8 len 64 → lbPair+owner) maps **every** open position → per-wallet `open_positions` / `open_pools` | **1 query, ~8s for all 88k** | `discover-all.ts` |
| **2 — quick** | Open positions only, page 1 per pool → live PnL + deposit size (whale signal) | ~1+pools calls, **1.5 wallets/s @ concurrency 10 → 88k in ~16h** | `quick-enrich.ts --limit N --concurrency 10` |
| **3 — deep** | Full history walk (all sigs → batch-parse → all pools → all positions) → win rate, avg invested/age, lifetime PnL, range, session | ~200 calls, ~90s/wallet — **top N only** | `analytics-enrich.ts --limit N --order tier2` |

`wallets.tier` tracks progress (1/2/3). Concurrency helper: `src/concurrency.ts` (`mapLimit`).

## Key files

| File | Role |
|------|------|
| `packages/core/src/classify.ts` | Classification: range (bin step → `BIN_STEP_BANDS`), tempo (avg age), play type, session (UTC hours) |
| `packages/db/src/index.ts` | `node:sqlite` layer, `upsertWallet` (**must COALESCE every field**), `migrate()`, `recordHistory`, `getWindowDelta` |
| `packages/ingest/src/adapters/meteora-datapi.ts` | `censusWalletPositions`, `getWalletQuickStats`, `getWalletAnalytics`, `getHistoricalPools`, `getPoolPnl`, `getPoolBinStep`, sanity bounds |
| `packages/ingest/src/adapters/jupiter.ts` | token prices + metadata |
| `packages/ingest/src/{discover-all,quick-enrich,analytics-enrich}.ts` | tier 1 / 2 / 3 runners |
| `packages/ingest/src/worker.ts` | 24/7 loop: census (hourly) + enrich + deep |
| `packages/web/src/app/page.tsx` | dashboard: sortable leaderboard, badges, USD/SOL, watchlist star + rename |

## Data model — which number is which

- **Fees earned** (lpagent, SOL→USD): the big "tens of thousands" number (202 SOL ≈ $15k). `FEES` column.
- **Profit 7d/30d/all** (lpagent): per-window PnL in SOL; `all` = lpagent's lifetime.
- **12h/24h**: deltas from **our own** snapshots (`wallet_history`) — empty until the worker has run that long. **No dummy values.**
- **On-chain PnL** (datapi): our own recompute. Deep = every position in every pool ever. Differs from lpagent = cross-check value.
- **PnL is always much smaller than fees** — that's impermanent loss, not a bug. The friend's tool shows the same (fees $17k vs profit $6k).

## Run

```bash
npm install && npm run web                 # dashboard :3737
# .env: SOLANA_RPC (Helius), HELIUS_API_KEY, METEORA_DATAPI
node --env-file=.env node_modules/.bin/tsx packages/ingest/src/discover-all.ts        # tier 1
node --env-file=.env node_modules/.bin/tsx packages/ingest/src/quick-enrich.ts --limit 2000 --concurrency 10   # tier 2
node --env-file=.env node_modules/.bin/tsx packages/ingest/src/analytics-enrich.ts --limit 50                  # tier 3
node --env-file=.env node_modules/.bin/tsx packages/ingest/src/worker.ts             # 24/7 loop
```
Worker tunables are hardcoded consts at the top of `worker.ts`. Range bands: `core/classify.ts`.

---

## Current status (2026-07-15)

### Done & verified against real data ✅
- **Discovery: solved.** Census = one gPA query → **88,042 wallets / 186,703 positions in 8s** (>2× the friend's 42k). DB holds **88,706** wallets.
- **Tiered enrichment + concurrency**: tier 2 measured at **1.5 wallets/s (concurrency 10)** → full 88k coverage in **~16h instead of 91 days**.
- **Deep analytics (tier 3)**: win rate, avg invested, avg age, positions/pools, lifetime PnL, monthly profit, first/last activity, range, session — all computed on-chain for ANY wallet. Verified: HUcjzp 59% win / 797 pos, 9ibgZH 65% / 1086 pos, EJRL 68% / 352 pos.
- **Reliable pool enumeration**: `getSignaturesForAddress` (complete — 21,423 sigs for 9ibg) + Helius `/v0/transactions` batch-parse + **LbPair discriminator match** (deterministic, no frequency guessing).
- Dashboard: sortable leaderboard, 4-dimension badges (range·tempo·play·session), full address → explorer, USD/SOL toggle + live SOL price, 12h/24h/7d/30d/all, watchlist star + rename (`/api/wallet`).
- Deploy-ready: typecheck clean, production build + server verified, `deploy/` (systemd, `setup.sh`, Cloudflare Tunnel).

### ⚠️ Data quality — broken pool pricing (understood + quarantined)

**Do not "fix" this with Jupiter spot prices — that was investigated and is wrong.**

What we verified:
- datapi's PnL **method is correct**. `/positions/{positionAddress}/historical` returns
  the event log (`add` / `remove` / `claim_fee`) with `amountX/Y`, `amountXUsd/YUsd`,
  `totalUsd` and `blockTime` — **each event valued at its own block time**, not spot.
  Recomputing PnL as `Σremove + Σclaim − Σadd` reproduces datapi's `pnlUsd` **exactly**
  (validated: $0.01 vs $0.01 on a closed position).
- So historical pricing is already handled. **Jupiter `/price/v3` is SPOT-only** —
  using it to value past deposits would wreck PnL for tokens that later rugged
  (a $10k deposit in a since-rugged token would be valued ~$0). Jupiter is fine for
  token metadata/icons and current-holdings valuation, NOT for historical PnL.

The actual defect: datapi's **price feed is broken for some pools** (seen: one position
at ~2e10 SOL — more than the SOL supply; wallet PnL of -$50T). It is per-pool corruption,
not a methodology error, so recomputing from the same events changes nothing.

Mitigation in place (two layers, both heuristics):
1. Per-position bounds `MAX_SOL_PER_POSITION` / `MAX_USD_PER_POSITION` — drop absurd rows.
2. **Wallet-level quarantine** (`WalletQuickStats.trusted`, `MAX_WALLET_DEPOSIT_SOL` /
   `MAX_WALLET_PNL_USD`): per-position bounds are insufficient because many
   moderately-wrong positions still sum to nonsense (162 positions → -$224M). Untrusted
   wallets are marked `tier=2` but stored with **no money values**, so they can never
   contaminate the ranking. Measured: ~4% of wallets quarantined.

Residual risk: values just under the caps (±$5–9M) may still be noise rather than real
whales. If precision matters, quarantine by detecting implausible **implied token price**
per event (`amountUsd / amount`) and blacklist the offending pools.

### Next
1. Run tier 2 across all 88k (~16h at concurrency 10) → then tier 3 on the real top N.
2. Deploy to VPS (everything is ready) so census + enrichment accumulate 24/7.
3. Optional precision: per-pool price-feed blacklist (see residual risk above).
4. Wallet detail page + Jupiter token icons; fabriq as a second source + cross-check.

### Notes / gotchas
- `upsertWallet` **must** COALESCE every field — partial upserts from different tiers must not wipe columns.
- Public RPC blocks `getProgramAccounts`; Helius is required.
- Helius credits are the real scaling constraint — tune `DEEP_PER_PASS` / `--concurrency`.
- Camoufox driver (`adapters/camoufox.ts`) is an unused fallback; Scrapling is the chosen path.
- Don't run `next build` while `next dev` is running — it corrupts `.next` (500s).

## Git
```bash
git add ...; git commit -m "feat/fix(scope): ..."; git push origin main
```
