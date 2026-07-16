// The 24/7 production worker (runs on the VPS).
//
// Division of labour: the Python/Scrapling scraper (scraper/discover.py) handles
// Cloudflare-protected lpagent discovery + metrics. THIS Node worker owns the
// on-chain side, each pass:
//   DISCOVER   — pull "wallets playing now" from the live DLMM program tx stream
//                (feePayer of non-swap txs) → accumulate toward thousands over time.
//   ENRICH     — range (bin step) + live PnL + session for a rate-limited slice.
//   DEEP-ENRICH— full lifetime PnL (all pools, all positions) for a small slice,
//                so the "who made the most" numbers fill in incrementally.
// Then sleep and repeat. Everything is env-overridable; the constants below are the
// hardcoded defaults you can edit.
//
// Env: SOLANA_RPC (Helius), HELIUS_API_KEY, METEORA_DATAPI, INGEST_INTERVAL_MS,
//      DISCOVER_PAGES, ENRICH_PER_PASS, DEEP_PER_PASS, DEEP_HISTORY_PAGES.

import { setTimeout as sleep } from "node:timers/promises";
import { classifyRangeByBinStep, classifySession, median } from "@lattice/core";
import { getDb, listWallets, upsertWallet, insertSnapshot, recordHistory } from "@lattice/db";
import {
  discoverAllOpenPositionWallets,
  discoverActiveWallets,
  getWalletPools,
  getHistoricalPools,
  getPoolBinStep,
  getWalletPnl,
  getWalletAnalytics,
} from "./adapters/meteora-datapi.js";

// ---- hardcoded defaults (edit these) ----------------------------------------
const DEFAULT_INTERVAL_MS = 5 * 60_000; // discovery is light — run often to accumulate
const DEFAULT_DISCOVER_PAGES = 5;       // DLMM program tx pages per pass (fresh activity)
const DEFAULT_ENRICH_PER_PASS = 30;     // light range/PnL/session enrichments per pass
const DEFAULT_DEEP_PER_PASS = 3;        // heavy full-lifetime enrichments per pass
const DEFAULT_DEEP_HISTORY_PAGES = 60;  // tx-history depth for deep-enrich

const INTERVAL_MS = Number(process.env.INGEST_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
const DISCOVER_PAGES = Number(process.env.DISCOVER_PAGES ?? DEFAULT_DISCOVER_PAGES);
const ENRICH_PER_PASS = Number(process.env.ENRICH_PER_PASS ?? DEFAULT_ENRICH_PER_PASS);
const DEEP_PER_PASS = Number(process.env.DEEP_PER_PASS ?? DEFAULT_DEEP_PER_PASS);
const DEEP_HISTORY_PAGES = Number(process.env.DEEP_HISTORY_PAGES ?? DEFAULT_DEEP_HISTORY_PAGES);
const RUN_ONCE = process.argv.includes("--once");

let _lastCensus = 0;
const CENSUS_INTERVAL_MS = 60 * 60_000; // full wallet census at most hourly

/** DISCOVER — the complete wallet universe via one getProgramAccounts census
 *  (~88k open-position wallets), throttled hourly; plus a light program stream
 *  each pass for freshness. */
async function discover(): Promise<number> {
  const now = Date.now();
  let n = 0;
  // PRIMARY: full census (every open DLMM position → owner), hourly.
  if (now - _lastCensus > CENSUS_INTERVAL_MS) {
    try {
      const wallets = await discoverAllOpenPositionWallets();
      const db = getDb();
      const stmt = db.prepare(
        `INSERT INTO wallets (address, source, last_activity, updated_at)
         VALUES (?, 'onchain-position', ?, ?)
         ON CONFLICT(address) DO UPDATE SET last_activity = excluded.last_activity`,
      );
      db.exec("BEGIN");
      for (const w of wallets) stmt.run(w, now, now);
      db.exec("COMMIT");
      _lastCensus = now;
      n += wallets.length;
      console.log(`  [census] ${wallets.length} wallets`);
    } catch (e) {
      console.warn(`  [census] ${(e as Error).message}`);
    }
  }
  // SECONDARY: fresh activity between censuses.
  try {
    for (const w of await discoverActiveWallets({ pages: DISCOVER_PAGES })) {
      upsertWallet({ address: w, source: "onchain", lastActivity: now });
      n++;
    }
  } catch (e) {
    console.warn(`  [discover stream] ${(e as Error).message}`);
  }
  return n;
}

/** ENRICH — range + live PnL + session for the least-recently-touched slice. */
async function enrich(limit: number): Promise<number> {
  const wallets = listWallets().slice(0, limit);
  let done = 0;
  for (const w of wallets) {
    try {
      let pools = await getWalletPools(w.address);
      if (pools.length === 0) pools = await getHistoricalPools(w.address, { pages: 3 }).catch(() => []);
      if (pools.length === 0) continue;
      const steps: number[] = [];
      for (const p of pools) {
        const bs = await getPoolBinStep(p);
        if (bs != null) steps.push(bs);
      }
      const { pnlUsd, pnlSol, openTimes } = await getWalletPnl(w.address, pools);
      upsertWallet({
        address: w.address,
        rangeStyle: classifyRangeByBinStep(median(steps)),
        session: classifySession(openTimes.map((t) => new Date(t * 1000).getUTCHours())),
        pnlUsd,
        pnlSol,
      });
      done++;
    } catch (err) {
      console.warn(`  enrich ${w.address.slice(0, 6)}: ${(err as Error).message}`);
    }
    await sleep(150);
  }
  return done;
}

/** DEEP-ENRICH — full on-chain "root analysis" for a few wallets (heavy). Computes
 *  win rate, avg invested, avg age, positions, lifetime PnL, range, session. */
async function deepEnrich(limit: number): Promise<number> {
  // prioritise wallets never analysed (win_rate null), oldest first
  const rows = getDb()
    .prepare(`SELECT address FROM wallets ORDER BY (win_rate IS NOT NULL), updated_at ASC LIMIT ?`)
    .all(limit) as Array<{ address: string }>;
  let done = 0;
  for (const { address } of rows) {
    try {
      const a = await getWalletAnalytics(address, { historyPages: DEEP_HISTORY_PAGES });
      if (a.totalPositions === 0) continue;
      upsertWallet({
        address,
        winRate: a.winRate == null ? null : a.winRate * 100,
        totalPools: a.totalPools,
        avgInvested: a.avgInvestedSol,
        avgAgeHours: a.avgAgeHours,
        avgMonthlyProfit: a.avgMonthlyProfitSol,
        pnlUsd: a.pnlUsd,
        pnlSol: a.pnlSol,
        rangeStyle: classifyRangeByBinStep(median(a.binSteps)),
        session: classifySession(a.openTimes.map((t) => new Date(t * 1000).getUTCHours())),
        firstActivity: a.firstActivity,
        lastActivity: a.lastActivity,
      });
      insertSnapshot({ wallet: address, timeframe: "all", positions: a.totalPositions, profit: a.pnlSol });
      done++;
    } catch (err) {
      console.warn(`  deep ${address.slice(0, 6)}: ${(err as Error).message}`);
    }
  }
  return done;
}

async function pass() {
  getDb();
  const t0 = Date.now();
  try { console.log(`[discover] +${await discover()} active wallets`); }
  catch (e) { console.warn(`[discover] ${(e as Error).message}`); }
  try { console.log(`[enrich] ${await enrich(ENRICH_PER_PASS)} wallets`); }
  catch (e) { console.warn(`[enrich] ${(e as Error).message}`); }
  try { console.log(`[deep] ${await deepEnrich(DEEP_PER_PASS)} wallets`); }
  catch (e) { console.warn(`[deep] ${(e as Error).message}`); }
  // snapshot for 12h/24h deltas
  for (const w of listWallets()) {
    recordHistory({ wallet: w.address, profitAll: w.pnlSol ?? null, feeEarned: w.feeEarned, positionsAll: w.totalPools });
  }
  console.log(`[pass] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

async function main() {
  if (RUN_ONCE) return void (await pass());
  console.log(`[worker] 24/7 start · interval ${INTERVAL_MS}ms`);
  while (true) {
    try { await pass(); } catch (e) { console.error(`[pass] fatal: ${(e as Error).message}`); }
    await sleep(INTERVAL_MS);
  }
}

main();
