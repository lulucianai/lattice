// TIER 1 — the free census. ONE getProgramAccounts query maps the entire universe:
// every wallet with an open position (~88k), how many positions it holds, and which
// pools. Costs one RPC call for everyone — no per-wallet work. The position count is
// the cheap ranking signal that decides who gets the expensive deeper tiers.
//
//   node --env-file=.env node_modules/.bin/tsx packages/ingest/src/discover-all.ts

import { getDb } from "@lattice/db";
import { censusWalletPositions } from "./adapters/meteora-datapi.js";

async function main() {
  const db = getDb();
  const count = () => (db.prepare("SELECT COUNT(*) n FROM wallets").get() as { n: number }).n;
  const before = count();

  console.log("Census: enumerating every open position (one RPC query)…");
  const t0 = Date.now();
  const census = await censusWalletPositions();
  const positions = [...census.values()].reduce((a, e) => a + e.positions, 0);
  console.log(
    `Mapped ${positions} positions → ${census.size} wallets in ${((Date.now() - t0) / 1000).toFixed(0)}s. Writing…`,
  );

  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO wallets (address, source, open_positions, open_pools, tier, last_activity, updated_at)
     VALUES (?, 'onchain-position', ?, ?, 1, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       open_positions = excluded.open_positions,
       open_pools     = excluded.open_pools,
       tier           = MAX(COALESCE(wallets.tier, 0), 1),
       last_activity  = excluded.last_activity`,
  );
  db.exec("BEGIN");
  for (const [address, e] of census) stmt.run(address, e.positions, e.pools.size, now, now);
  db.exec("COMMIT");

  const top = [...census.entries()].sort((a, b) => b[1].positions - a[1].positions).slice(0, 5);
  console.log(`DB wallets: ${before} → ${count()} (+${count() - before} new).`);
  console.log(
    "Top by open positions:",
    top.map(([w, e]) => `${w.slice(0, 6)}=${e.positions}p/${e.pools.size}pools`).join("  "),
  );
}

main();
