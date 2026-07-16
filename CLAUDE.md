# lattice — Claude handoff guide

> Baca **Status terkini** sebelum lanjut. Detail install/run lengkap ada di `README.md`.

---

## Project

| Item | Value |
|------|-------|
| Nama | **lattice** (codename samaran) — tracker top Meteora DLMM LP wallets |
| Opsec | Nama/README/judul-halaman **netral** (nggak nyebut Meteora/DLMM) + `robots: noindex`. **CATATAN:** isi kode tetap memuat endpoint (`dlmm.datapi.meteora.ag`, program DLMM, lpagent) → kalau repo **public**, GitHub code-search TETAP bisa nemu. Proteksi nyata = repo private. User pilih public + samaran (sudah diberi tahu risikonya). |
| Path | `D:\codevibe\topdlmm` (folder lokal masih nama lama; **project/repo = `lattice`**) |
| Goal | Scrape SEMUA wallet aktif Meteora DLMM → dataset lengkap & real per-wallet (PnL, fee, playstyle) → leaderboard. Mirip tool teman user (header 42k wallet + leaderboard playstyle). Buat riksa/riset. |
| Referensi konsep | web teman user (gambar), `bengbeng.app` (full-history PnL 1 wallet, kita = massal otomatis) |
| Prinsip | **NOL dummy** — real scrape + on-chain + normalisasi, akumulatif 24/7 |

Stack: **Node/TS monorepo (npm workspaces) + Python scraper (Scrapling)**, DB `node:sqlite` (Postgres-ready untuk VPS). Node 20+, Python 3.10+.

## Arsitektur (3 proses, 1 DB `data/lattice.sqlite`)

```
Python/Scrapling  scraper/discover.py   → DISCOVERY lpagent (Cloudflare-hard)
Node worker       packages/ingest/worker.ts → discover on-chain + enrich + deep-enrich
Next.js           packages/web           → dashboard :3737
```

**Pembagian:** lpagent/fabriq di belakang Cloudflare → **Scrapling** (`StealthySession(solve_cloudflare=True)`, lebih stabil dari Camoufox mentah). On-chain + enrichment + UI = Node.

## Sumber data (endpoint terverifikasi)

| Sumber | Dipakai untuk | Catatan |
|--------|---------------|---------|
| lpagent `app.lpagent.io/smart-lp?page=N` | discovery kurasi (~309) + metrik (win rate, fee, avg age, 7d/30d/all) | RSC + Cloudflare → scrape Scrapling. Full addr di href `?address=`, link ke solscan |
| **Helius** `mainnet.helius-rpc.com` (key di `.env`) | `getProgramAccounts` (posisi terbuka; owner offset 40, lbPair offset 8) + parsed tx-history + active-wallet stream | RPC publik BLOKIR gPA; Helius izinkan. Key user ada di `.env` (gitignored) |
| **Meteora datapi** `dlmm.datapi.meteora.ag` | PnL per pool (`/positions/{pool}/pnl?user=` → list posisi ber-`pnlUsd`/`pnlSol`, paginated), pool meta (`/pools/{pool}` → `pool_config.bin_step`), pool list (`/pools?page=N` → 119k pool) | JSON, CORS terbuka, no Cloudflare. Nggak ada endpoint LP-per-pool |
| **Jupiter** `lite-api.jup.ag` | harga token (`/price/v3?ids=`) + metadata (`/tokens/v2/search`) | valuasi token / fallback |
| CoinGecko | harga SOL realtime (USD toggle) | `web/src/lib/price.ts`, cache 60s + fallback |

## File penting

| File | Peran |
|------|-------|
| `packages/core/src/classify.ts` | Klasifikasi: range (bin step, default 70 → `BIN_STEP_BANDS`), tempo (avg age), play (fast/multi), session (jam UTC) |
| `packages/db/src/index.ts` | DB `node:sqlite`: wallets/snapshots/history + `upsertWallet` (COALESCE!), `recordHistory`, `getWindowDelta` |
| `packages/ingest/src/adapters/meteora-datapi.ts` | Helius + datapi: `discoverActiveWallets`, `getWalletPools`, `getHistoricalPools` (freq+validasi), `getPoolPnl` (paginated), `getWalletDeepPnl`, `getWalletHoldingsUsd` |
| `packages/ingest/src/adapters/jupiter.ts` | harga + metadata token |
| `packages/ingest/src/adapters/lpagent.ts` | parser smart-lp/pools (pure, teruji fixture) |
| `packages/ingest/src/worker.ts` | worker 24/7: discover→enrich→deep-enrich→snapshot |
| `packages/ingest/src/{enrich,deep-enrich}.ts` | runner one-off (range/PnL; lifetime `--full`) |
| `scraper/discover.py` | Scrapling scraper lpagent → DB |
| `packages/web/src/app/page.tsx` | dashboard: header + leaderboard sortable + badge + USD/SOL + 12h/24h/7d/30d/all |

## Data model — angka mana yang mana (PENTING)

- **Fee earned** (lpagent, SOL→USD): angka besar "puluhan ribu" (202 SOL ≈ $15k). Kolom `FEES`.
- **Profit 7d/30d/all** (lpagent): PnL per-window, SOL. `all` = lifetime versi lpagent.
- **12h/24h**: DELTA dari snapshot bot sendiri (`wallet_history`). Kosong sampai ada ≥2 snapshot — **no dummy**.
- **Live PnL / deep PnL** (datapi): recompute on-chain. Deep = sum semua posisi (open+closed) semua pool ever → beda dari lpagent = nilai cross-check.

## Cara jalanin (ringkas — detail di README)

```bash
npm install && npm run db:seed && npm run web          # dev, :3737
# .env: SOLANA_RPC (Helius), HELIUS_API_KEY, METEORA_DATAPI
node --env-file=.env node_modules/.bin/tsx packages/ingest/src/worker.ts   # 24/7
python scraper/discover.py --pages 30                  # lpagent (Scrapling)
tsx packages/ingest/src/deep-enrich.ts --full --limit 50   # lifetime penuh top wallet
```
Tunable hardcoded di atas `worker.ts` (INTERVAL 5min, DISCOVER_PAGES 8, ENRICH_PER_PASS 30, DEEP_PER_PASS 3, DEEP_HISTORY_PAGES 60). Range bands di `core/classify.ts`.

---

## Status terkini (2026-07-15)

### Sudah beres & terverifikasi data nyata ✅
- **Dashboard** mirip tool teman: header lengkap + leaderboard **sortable** + badge 4-dimensi (range·tempo·play·session) + full addr→Solscan + toggle **USD/SOL** + harga SOL live + timeframe 12h/24h/7d/30d/all.
- **Discovery on-chain** (`discoverActiveWallets`): wallet aktif dari stream tx DLMM → ribuan akumulatif. Tes: +17 wallet/pass (DB 36→53).
- **Deep lifetime PnL** (`getWalletDeepPnl` + `--full`): enumerasi pool via frekuensi+validasi datapi (9ibgZH 5→57 pool, $1.9k→$3k di depth 30). Makin dalam makin penuh.
- **Enrichment**: range (bin step), live PnL USD/SOL (paginated all positions), session (timestamp), tempo/play.
- **Jupiter** wired (harga+metadata+holdings). **Scrapling** scraper lpagent. **Worker 24/7** produksi (tes `--once` 112s/pass).
- DB 53 wallet (36 lpagent + 17 onchain), 26 dengan PnL.

### Baru selesai (2026-07-15, batch 1-4) ✅
- **Top-LP per pool** — `getActivePools` (datapi /pools sort by vol24h) + `discoverPoolLps`
  (feePayer non-swap tx pool = LP asli). Discovery utama worker → **+102 wallet/pass**
  (vs 17), berkualitas (add/remove liquidity, bukan swapper). Ini juga **filter quality**.
- **Kalibrasi bin step** — `BIN_STEP_BANDS` disesuaikan distribusi asli (stables bs 4-20,
  memecoin 100+): tight <40, normal 40-90, wide 90-250, super_degen >250.
- **Produksi** — `deploy/` (systemd worker/web/scraper + timer, cloudflared config,
  deploy README). Fix `busy_timeout` (Python+Node dua writer ke SQLite). Postgres path
  didokumentasikan (query surface terisolasi).

### Discovery SOLVED — direct wallet census (2026-07-15) ✅
User's insight: don't discover via pools — enumerate wallets DIRECTLY. `getProgram
Accounts(DLMM, filter PositionV2 discriminator 75b0d4c7f5b485b6, dataSlice owner @40)`
→ EVERY wallet with an open DLMM position in ONE query: **87,967 unique wallets in 7s**
(>2× the friend's 42k). `discoverAllOpenPositionWallets()` + runner `discover-all.ts`
(bulk insert, transaction). DB went 318→88,200. Worker's discover() now runs this
census hourly + light program-stream for freshness (pool-sweep dropped — census is
strictly better: no swap noise/overlap/plateau). LbPair pool discriminator = 210b3162
b565b10d. Only OPEN positions (closed-only wallets caught by stream over time).
Per-wallet pool enumeration (getHistoricalPools) also rewritten: getSignaturesForAddress
(complete, e.g. 21,423 sigs for 9ibg) + Helius /v0/transactions batch-parse (100/call) +
discriminator verify — reliable, vs the old flaky /addresses/{w}/transactions.
NOW THE WORK = enriching 88k wallets (analytics) incrementally 24/7.

### Depth: on-chain per-wallet analytics (2026-07-15) ✅ — the "root analysis"
`getWalletAnalytics` (meteora-datapi.ts) computes win rate, avg invested, avg age,
total positions/pools, lifetime PnL, avg monthly profit, first/last activity, range,
session — ENTIRELY on-chain from datapi position data (each position has pnl,
allTimeDeposits.total, createdAt/closedAt), for ANY wallet (not just lpagent). Runner:
`analytics-enrich.ts --limit N --history-pages P --order new|fee|profit`. Worker's
deep stage now calls it (was getWalletDeepPnl). Verified: HUcjzp 59% win / 797 pos,
9ibgZH 65% / 1086 pos, EJRL 68% / 352 pos — computed & shown on dashboard. Note: this
OVERWRITES lpagent's scraped win-rate/avg-age with on-chain values (canonical, one
source, comparable across all wallets). getPoolPnl now returns per-position `rows`.

### Watchlist + naming (2026-07-15) ✅
Star (watchlist) kiri rank + pena (custom name) kanan wallet. Write via
`app/api/wallet/route.ts` → `updateWallet` (web/lib/db.ts) → SQLite. Client komponen
`app/WalletControls.tsx`. Kolom `starred`/`custom_name` sudah ada di DB. Terverifikasi.

### Next (belum) ⚠️
1. **Wallet detail page** → lalu wire **Jupiter ke UI** (simbol/ikon token per posisi).
   Bisa juga tambah filter "hanya watchlist" (WHERE starred=1) di leaderboard.
   Adapter Jupiter sudah siap; leaderboard per-wallet nggak punya slot token.
2. **Jalanin deep-enrich `--full` massal di VPS** → lifetime penuh (berat, pantau kredit Helius).
3. **fabriq** sumber kedua + **normalisasi/cross-check** lpagent vs datapi (flag beda).
4. Deploy beneran ke VPS (systemd + Tunnel) biar data akumulasi ke ribuan.

### Catatan
- `upsertWallet` HARUS COALESCE tiap field (upsert parsial dari sumber beda jangan wipe kolom lain).
- Camoufox driver Node (`adapters/camoufox.ts`) = fallback; Scrapling jalur utama.
- Deep recompute berat (~140s/wallet depth 30) → incremental, bukan sekaligus.

## Git
```bash
git add ...; git commit -m "feat/fix(scope): ..."
```
