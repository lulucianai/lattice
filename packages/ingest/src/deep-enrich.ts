// Deep lifetime enrichment — the "bengbeng for every wallet" pass.
//
// bengbeng.app reads ONE wallet's full DLMM history on demand. This does the same
// computation (sum PnL across ALL positions in ALL pools the wallet ever used) but
// for a SLICE of our tracked wallets each run, so coverage accumulates over time
// into a real lifetime-PnL leaderboard.
//
// It is intentionally heavy (Helius tx-history + datapi pagination per wallet), so:
//   --limit N          how many wallets to process this run (default 20)
//   --history-pages P   tx-history depth per wallet (default 8; higher = fuller, slower)
//   --order fee|profit  which wallets to prioritize (default fee, the big numbers)
//
// Run: node --env-file=.env node_modules/.bin/tsx packages/ingest/src/deep-enrich.ts --limit 20

import { setTimeout as sleep } from "node:timers/promises";
import { classifySession } from "@lattice/core";
import { getDb, upsertWallet } from "@lattice/db";
import { getWalletDeepPnl } from "./adapters/meteora-datapi.js";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function main() {
  const limit = Number(arg("limit", "20"));
  // --full = walk the wallet's entire tx-history (all pools ever) for a truly
  // complete lifetime figure; otherwise use --history-pages (default 8, faster).
  const full = process.argv.includes("--full");
  const historyPages = full ? 150 : Number(arg("history-pages", "8"));
  const order = arg("order", "fee") === "profit" ? "wallet_snapshots" : "fee";

  const db = getDb();
  // Prioritize by cumulative fee (the "tens of thousands" signal) so the biggest
  // players are deep-scraped first; re-runs refresh least-recently-updated.
  const rows =
    order === "fee"
      ? (db
          .prepare(
            `SELECT address FROM wallets ORDER BY (fee_earned IS NULL), fee_earned DESC, updated_at ASC LIMIT ?`,
          )
          .all(limit) as Array<{ address: string }>)
      : (db
          .prepare(
            `SELECT w.address FROM wallets w
             JOIN wallet_snapshots s ON s.wallet=w.address AND s.timeframe='all'
             ORDER BY s.profit DESC LIMIT ?`,
          )
          .all(limit) as Array<{ address: string }>);

  console.log(`Deep-enriching ${rows.length} wallets (history-pages ${historyPages})…`);
  for (const { address } of rows) {
    const t0 = Date.now();
    try {
      const d = await getWalletDeepPnl(address, { historyPages });
      const session = classifySession(d.openTimes.map((t) => new Date(t * 1000).getUTCHours()));
      upsertWallet({ address, pnlUsd: d.pnlUsd, pnlSol: d.pnlSol, session });
      console.log(
        `  ${address.slice(0, 6)} — ${d.pools} pools / ${d.positions} positions → ` +
          `lifetime PnL $${d.pnlUsd.toFixed(0)} / ◎${d.pnlSol.toFixed(1)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
      );
    } catch (err) {
      console.warn(`  ${address.slice(0, 6)} — ${(err as Error).message}`);
    }
    await sleep(200);
  }
  console.log("Done.");
}

main();
