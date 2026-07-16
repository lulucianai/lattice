// Deep per-wallet analytics enrichment — the "root analysis" pass.
//
// Computes win rate, avg invested, avg hold age, total positions/pools, lifetime
// PnL, monthly profit, first/last activity, range + session ENTIRELY on-chain
// (Meteora datapi), for ANY wallet — not just lpagent-scraped ones. Writes them
// into the same metric columns so every wallet has comparable, real analytics.
//
// Run: node --env-file=.env node_modules/.bin/tsx packages/ingest/src/analytics-enrich.ts \
//        --limit 20 --history-pages 30 [--order fee|profit|new]

import { setTimeout as sleep } from "node:timers/promises";
import { classifyRangeByBinStep, classifySession, median } from "@lattice/core";
import { getDb, upsertWallet, insertSnapshot } from "@lattice/db";
import { getWalletAnalytics } from "./adapters/meteora-datapi.js";

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function main() {
  const limit = Number(arg("limit", "20"));
  const historyPages = Number(arg("history-pages", "30"));
  const order = arg("order", "new");
  const db = getDb();

  // "new" = wallets never analysed yet (win_rate null) first; else biggest fee/profit.
  const sql =
    order === "fee"
      ? `SELECT address FROM wallets ORDER BY (fee_earned IS NULL), fee_earned DESC, updated_at ASC LIMIT ?`
      : order === "profit"
        ? `SELECT w.address FROM wallets w LEFT JOIN wallet_snapshots s ON s.wallet=w.address AND s.timeframe='all' ORDER BY COALESCE(s.profit,0) DESC LIMIT ?`
        : `SELECT address FROM wallets ORDER BY (win_rate IS NOT NULL), updated_at ASC LIMIT ?`;
  const rows = db.prepare(sql).all(limit) as Array<{ address: string }>;

  console.log(`Analysing ${rows.length} wallets (history-pages ${historyPages})…`);
  let done = 0;
  for (const { address } of rows) {
    const t0 = Date.now();
    try {
      const a = await getWalletAnalytics(address, { historyPages });
      if (a.totalPositions === 0) {
        console.log(`  ${address.slice(0, 6)} — no positions found`);
        continue;
      }
      const session = classifySession(a.openTimes.map((t) => new Date(t * 1000).getUTCHours()));
      upsertWallet({
        address,
        winRate: a.winRate == null ? null : a.winRate * 100, // stored as %
        totalPools: a.totalPools,
        avgInvested: a.avgInvestedSol,     // SOL
        avgAgeHours: a.avgAgeHours,
        avgMonthlyProfit: a.avgMonthlyProfitSol, // SOL
        pnlUsd: a.pnlUsd,
        pnlSol: a.pnlSol,
        rangeStyle: classifyRangeByBinStep(median(a.binSteps)),
        session,
        firstActivity: a.firstActivity,
        lastActivity: a.lastActivity,
      });
      // lifetime totals into the "all" snapshot (positions + profit in SOL)
      insertSnapshot({ wallet: address, timeframe: "all", positions: a.totalPositions, profit: a.pnlSol });
      done++;
      console.log(
        `  ${address.slice(0, 6)} — ${a.totalPositions} pos / ${a.totalPools} pools · ` +
          `win ${a.winRate == null ? "—" : (a.winRate * 100).toFixed(0) + "%"} · ` +
          `avgInv ◎${(a.avgInvestedSol ?? 0).toFixed(1)} · avgAge ${(a.avgAgeHours ?? 0).toFixed(1)}h · ` +
          `PnL $${a.pnlUsd.toFixed(0)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
      );
    } catch (err) {
      console.warn(`  ${address.slice(0, 6)} — ${(err as Error).message}`);
    }
    await sleep(150);
  }
  console.log(`Done. Analysed ${done}/${rows.length} wallets.`);
}

main();
