// TIER 2 — the cheap ranking pass, run concurrently.
//
// Takes wallets the census found (tier 1), ordered by open-position count, and
// fetches their live PnL + deposit size from open positions only (~1 + pools calls,
// a few seconds each). With --concurrency this covers thousands of wallets per hour
// instead of the ~40/hour a full-history walk manages — which is what makes the 88k
// backlog tractable. The result ranks who actually deserves TIER 3 (deep analytics).
//
//   node --env-file=.env node_modules/.bin/tsx packages/ingest/src/quick-enrich.ts \
//     --limit 2000 --concurrency 10

import { getDb, upsertWallet } from "@lattice/db";
import { getWalletQuickStats } from "./adapters/meteora-datapi.js";
import { mapLimit } from "./concurrency.js";

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function main() {
  const limit = Number(arg("limit", "1000"));
  const concurrency = Number(arg("concurrency", "10"));
  const db = getDb();

  // biggest open books first; skip wallets already quick/deep enriched
  const rows = db
    .prepare(
      `SELECT address FROM wallets
       WHERE COALESCE(tier,0) = 1 AND COALESCE(open_positions,0) > 0
       ORDER BY open_positions DESC LIMIT ?`,
    )
    .all(limit) as Array<{ address: string }>;

  if (rows.length === 0) {
    console.log("Nothing to do — no tier-1 wallets pending (run discover-all first).");
    return;
  }

  console.log(`Quick-enriching ${rows.length} wallets, concurrency ${concurrency}…`);
  const t0 = Date.now();
  let done = 0, withMoney = 0, quarantined = 0;

  await mapLimit(
    rows,
    concurrency,
    async ({ address }) => {
      const s = await getWalletQuickStats(address);
      // Untrusted = at least one of its pools has a broken price feed. Mark the
      // wallet done (so we don't reprocess it) but store NO money values, so it
      // can never contaminate the ranking. Better a gap than a fake whale.
      upsertWallet(
        s.trusted
          ? {
              address,
              tier: 2,
              openPools: s.pools,
              pnlUsd: s.pnlUsd,
              pnlSol: s.pnlSol,
              // avg deposit per open position (SOL) — the whale signal
              avgInvested: s.positions > 0 ? s.depositSol / s.positions : null,
            }
          : { address, tier: 2, openPools: s.pools },
      );
      done++;
      if (!s.trusted) quarantined++;
      else if (s.depositUsd > 0) withMoney++;
      if (done % 100 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`  ${done}/${rows.length} · ${rate.toFixed(1)}/s · eta ${(((rows.length - done) / rate) / 60).toFixed(0)}m`);
      }
    },
    (item, err) => console.warn(`  ${item.address.slice(0, 6)}: ${err.message}`),
  );

  const secs = (Date.now() - t0) / 1000;
  console.log(
    `Done. ${done}/${rows.length} in ${secs.toFixed(0)}s (${(done / secs).toFixed(1)}/s) · ` +
      `${withMoney} with deposits · ${quarantined} quarantined (broken pool pricing).`,
  );
}

main();
