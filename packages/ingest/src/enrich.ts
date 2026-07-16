// Range enrichment: for each tracked wallet, enumerate its OPEN DLMM positions
// via Helius getProgramAccounts, read each pool's bin step from Meteora datapi,
// take the median, and classify range (tight/normal/wide/super_degen) per the
// user's rule (default bin step 70). Writes rangeStyle back to the DB.
//
// Run: node --env-file=.env node_modules/.bin/tsx packages/ingest/src/enrich.ts
// (needs SOLANA_RPC = a getProgramAccounts-enabled endpoint, e.g. Helius.)
//
// Wallets with no OPEN positions right now get no range yet — historical range
// needs the Helius parsed tx-history pass (separate, heavier). This fills the
// active ones cheaply.

import { classifyRangeByBinStep, classifySession, median } from "@lattice/core";
import { listWallets, upsertWallet } from "@lattice/db";
import {
  getWalletPools,
  getPoolBinStep,
  getWalletPnl,
} from "./adapters/meteora-datapi.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const wallets = listWallets();
  console.log(`Enriching ${wallets.length} wallets…`);
  let filled = 0;
  const binStepCache = new Map<string, number | null>();

  for (const w of wallets) {
    try {
      const pools = await getWalletPools(w.address);
      if (pools.length === 0) {
        console.log(`  ${w.address.slice(0, 6)} — no open positions`);
        continue;
      }
      const steps: number[] = [];
      for (const p of pools) {
        let bs = binStepCache.get(p);
        if (bs === undefined) {
          bs = await getPoolBinStep(p);
          binStepCache.set(p, bs);
          await sleep(120); // be polite to datapi
        }
        if (bs != null) steps.push(bs);
      }
      const med = median(steps);
      const range = classifyRangeByBinStep(med);
      const { pnlUsd, pnlSol, openTimes } = await getWalletPnl(w.address, pools);
      const session = classifySession(openTimes.map((t) => new Date(t * 1000).getUTCHours()));
      upsertWallet({ address: w.address, rangeStyle: range, session, pnlUsd, pnlSol });
      if (range) filled++;
      console.log(
        `  ${w.address.slice(0, 6)} — ${pools.length} pools, binStep ${med} → ${range} · ${session} · PnL $${pnlUsd.toFixed(0)}/◎${pnlSol.toFixed(2)}`,
      );
    } catch (err) {
      console.warn(`  ${w.address.slice(0, 6)} — ${(err as Error).message}`);
    }
    await sleep(150); // gentle rate limit between wallets
  }
  console.log(`Done. Filled range for ${filled}/${wallets.length} wallets.`);
}

main();
