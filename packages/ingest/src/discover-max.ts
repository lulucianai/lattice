// Aggressive discovery — sweep many active pools deeply to surface as many LP
// wallets (and whales) as fast as possible. Accumulates into the DB; run it often.
//
//   node --env-file=.env tsx packages/ingest/src/discover-max.ts --pools 100 --pages 3
//
// Breadth (--pools, by 24h volume) × depth (--pages of tx-history per pool) is the
// lever: more of both → more wallets. datapi has ~119k pools total, so over many
// runs this reaches tens of thousands of wallets.

import { getDb, upsertWallet } from "@lattice/db";
import {
  getActivePools,
  discoverPoolLps,
  discoverActiveWallets,
} from "./adapters/meteora-datapi.js";

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function main() {
  const poolCount = Number(arg("pools", "100"));
  // --deep backfills historical LPs: fewer pools, many pages back (default 3).
  const deep = process.argv.includes("--deep");
  const pages = Number(arg("pages", deep ? "20" : "3"));
  getDb();

  const before = countWallets();
  const found = new Set<string>();
  const now = Date.now();
  const add = (w: string) => {
    if (!found.has(w)) {
      found.add(w);
      upsertWallet({ address: w, source: "pool-lp", lastActivity: now });
    }
  };

  // (1) program stream — LP actions across ALL pools at once
  try {
    const stream = await discoverActiveWallets({ pages: 15 });
    stream.forEach(add);
    console.log(`[stream] ${stream.length} wallets`);
  } catch (e) {
    console.warn(`[stream] ${(e as Error).message}`);
  }

  // (2) pool sweep — deeper pages harvest historical LPs, not just current ones
  const pools = await getActivePools(poolCount);
  console.log(`Sweeping ${pools.length} pools × ${pages} pages${deep ? " (deep backfill)" : ""}…`);
  let done = 0;
  for (const p of pools) {
    try {
      (await discoverPoolLps(p.address, pages)).forEach(add);
    } catch (e) {
      console.warn(`  ${p.name}: ${(e as Error).message}`);
    }
    if (++done % 20 === 0) console.log(`  …${done}/${pools.length} pools, ${found.size} wallets so far`);
  }

  const after = countWallets();
  console.log(`Done. ${found.size} unique wallets this run. DB: ${before} → ${after} (+${after - before} new).`);
}

function countWallets(): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM wallets").get() as { n: number }).n;
}

main();
