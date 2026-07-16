// Meteora on-chain adapter (source of truth for pools).
//
// NOTE: Meteora migrated its public API. The legacy `dlmm-api.meteora.ag/pair/*`
// paths now 404; `amm-v2.meteora.ag` is live but shaped differently. The exact
// current "list DLMM pools" path must be captured from the live app's network
// traffic (app.meteora.ag → DevTools → XHR) and dropped into POOLS_ENDPOINT.
// Everything downstream is written against the normalized Pool type, so wiring
// the real endpoint is a change confined to `parsePool` + POOLS_ENDPOINT.

import type { Pool } from "@lattice/core";
import type { PoolSource } from "./types.js";

const POOLS_ENDPOINT =
  process.env.METEORA_POOLS_ENDPOINT ?? "https://amm-v2.meteora.ag/pools";

export class MeteoraClient implements PoolSource {
  async listPools(opts: { limit?: number } = {}): Promise<Pool[]> {
    const limit = opts.limit ?? 100;
    const res = await fetch(`${POOLS_ENDPOINT}?limit=${limit}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Meteora pools ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as unknown;
    return normalizePools(json);
  }
}

/** Defensive normalizer — tolerates the array-or-{data:[]} shapes these APIs use. */
function normalizePools(json: unknown): Pool[] {
  const rows: any[] = Array.isArray(json)
    ? json
    : (json as any)?.data ?? (json as any)?.groups ?? [];
  return rows.map(parsePool).filter((p): p is Pool => p != null);
}

function parsePool(row: any): Pool | null {
  if (!row?.address && !row?.pool_address) return null;
  return {
    address: row.address ?? row.pool_address,
    name: row.name ?? `${row.base_symbol ?? "?"}-${row.quote_symbol ?? "?"}`,
    baseMint: row.base_mint ?? row.mint_x ?? "",
    quoteMint: row.quote_mint ?? row.mint_y ?? "",
    baseSymbol: row.base_symbol ?? "?",
    quoteSymbol: row.quote_symbol ?? "?",
    binStep: Number(row.bin_step ?? row.binStep ?? 0),
  };
}
