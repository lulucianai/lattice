// Offline verification of the lpagent DOM parsers against captured fixtures.
// Run: npm run verify -w @lattice/ingest   (no network / browser needed)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parsePoolCard } from "./lpagent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(path.join(here, "__fixtures__", "lpagent-pools.json"), "utf8"),
) as { address: string; text: string }[];

const [trump, brain] = fixtures.map((f) => parsePoolCard(f.address, f.text));

assert.equal(trump!.pair, "TrumpCoin / SOL");
assert.equal(trump!.mcap, 367_500);
assert.equal(trump!.orgScore, 52);
assert.equal(trump!.binStep, 100);
assert.equal(trump!.baseFeePct, 3.69);
assert.equal(trump!.liquidity, 27_980);
assert.equal(trump!.volume24h, 1_930_000);
assert.equal(trump!.fee24h, 71_120);
assert.equal(trump!.holders, 7_531);
assert.equal(trump!.feeTvl24hPct, 254.22);

assert.equal(brain!.pair, "brain / SOL");
assert.equal(brain!.mcap, 373_840);
assert.equal(brain!.baseFeePct, 6.08);
assert.equal(brain!.volume24h, 403_710);
assert.equal(brain!.fee24h, 24_550);

console.log("✓ lpagent pool parser: all assertions passed (2 fixtures)");
