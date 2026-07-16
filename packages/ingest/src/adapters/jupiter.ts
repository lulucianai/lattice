// Jupiter adapter — token USD prices + metadata (symbol/name/icon/decimals).
//
// Role: datapi already returns PnL in USD+SOL, but Jupiter completes valuation —
// it prices ANY mint (incl. long-tail memecoins datapi may not value) and gives
// token metadata for display. Endpoints verified 2026-07-15:
//   price:  https://lite-api.jup.ag/price/v3?ids=MINT1,MINT2  → {mint:{usdPrice,decimals,...}}
//   search: https://lite-api.jup.ag/tokens/v2/search?query=MINT → [{id,symbol,name,icon,decimals}]

const JUP_BASE = process.env.JUPITER_API ?? "https://lite-api.jup.ag";

export interface TokenMeta {
  mint: string;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  decimals: number | null;
  usdPrice: number | null;
}

const _priceCache = new Map<string, number | null>();
const _metaCache = new Map<string, TokenMeta>();

/** Batch USD prices by mint (chunks of 100). Cached across the process. */
export async function getUsdPrices(mints: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const todo = [...new Set(mints)].filter((m) => {
    if (_priceCache.has(m)) {
      out.set(m, _priceCache.get(m)!);
      return false;
    }
    return true;
  });
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    try {
      const res = await fetch(`${JUP_BASE}/price/v3?ids=${chunk.join(",")}`);
      const j = res.ok ? ((await res.json()) as Record<string, { usdPrice?: number }>) : {};
      for (const m of chunk) {
        const p = j[m]?.usdPrice ?? null;
        _priceCache.set(m, p);
        out.set(m, p);
      }
    } catch {
      for (const m of chunk) out.set(m, null);
    }
  }
  return out;
}

/** Token metadata by mint (symbol/name/icon/decimals + price). Cached. */
export async function getTokenMeta(mint: string): Promise<TokenMeta> {
  const cached = _metaCache.get(mint);
  if (cached) return cached;
  const meta: TokenMeta = { mint, symbol: null, name: null, icon: null, decimals: null, usdPrice: null };
  try {
    const res = await fetch(`${JUP_BASE}/tokens/v2/search?query=${mint}`);
    if (res.ok) {
      const arr = (await res.json()) as Array<{
        id: string; symbol?: string; name?: string; icon?: string; decimals?: number;
      }>;
      const hit = arr.find((t) => t.id === mint) ?? arr[0];
      if (hit) {
        meta.symbol = hit.symbol ?? null;
        meta.name = hit.name ?? null;
        meta.icon = hit.icon ?? null;
        meta.decimals = hit.decimals ?? null;
      }
    }
    meta.usdPrice = (await getUsdPrices([mint])).get(mint) ?? null;
  } catch {
    /* leave nulls */
  }
  _metaCache.set(mint, meta);
  return meta;
}
