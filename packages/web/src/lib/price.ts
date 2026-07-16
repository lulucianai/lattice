// Realtime SOL/USD price from CoinGecko, cached for 60s (Next fetch cache).
// Falls back to a static price if the network is unavailable (e.g. offline dev),
// so the dashboard always renders.

const FALLBACK_SOL_USD = 200;

export async function getSolPrice(): Promise<{ usd: number; live: boolean }> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { next: { revalidate: 60 } },
    );
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { solana?: { usd?: number } };
    const usd = j.solana?.usd;
    if (typeof usd === "number" && usd > 0) return { usd, live: true };
    throw new Error("no price");
  } catch {
    return { usd: FALLBACK_SOL_USD, live: false };
  }
}
