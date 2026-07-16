// Full Meteora DLMM wallet census — one getProgramAccounts query enumerates EVERY
// wallet with an open position (~88k) and bulk-inserts them. Run periodically
// (e.g. hourly) — it's the primary, complete discovery source.
//
//   node --env-file=.env node_modules/.bin/tsx packages/ingest/src/discover-all.ts

import { getDb } from "@lattice/db";
import { discoverAllOpenPositionWallets } from "./adapters/meteora-datapi.js";

async function main() {
  const db = getDb();
  const count = () => (db.prepare("SELECT COUNT(*) n FROM wallets").get() as { n: number }).n;
  const before = count();

  console.log("Enumerating all open-position wallets (getProgramAccounts)…");
  const t0 = Date.now();
  const wallets = await discoverAllOpenPositionWallets();
  console.log(`Found ${wallets.length} unique wallets in ${((Date.now() - t0) / 1000).toFixed(0)}s. Inserting…`);

  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO wallets (address, source, last_activity, updated_at)
     VALUES (?, 'onchain-position', ?, ?)
     ON CONFLICT(address) DO UPDATE SET last_activity = excluded.last_activity`,
  );
  db.exec("BEGIN");
  for (const w of wallets) stmt.run(w, now, now);
  db.exec("COMMIT");

  console.log(`DB wallets: ${before} → ${count()} (+${count() - before} new).`);
}

main();
