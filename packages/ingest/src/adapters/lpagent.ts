// lpagent.io aggregator adapter — PRIMARY data source for rich wallet/pool analytics.
//
// Reality (verified via network inspection): app.lpagent.io is a Next.js RSC app
// behind Cloudflare. There is NO public JSON API — page data is streamed as RSC
// flight payloads, and plain fetch() gets a 403 Cloudflare challenge. Deep-linking
// to a pool detail even errors; the app expects in-app navigation.
//
// So ingestion is browser-driven: a stealth headless browser (Playwright) that
// navigates like a user and hands each pool card's innerText to the PURE parsers
// below. Parsing keys off stable text labels (MCAP, Org Score, Bin Step, …) rather
// than churny Tailwind class names, and is verified against captured fixtures in
// __fixtures__/ (see verify-parsers.ts).

import type { AggregatorSource } from "./types.js";

/** One pool card scraped off /pools. */
export interface LpAgentPool {
  poolAddress: string;
  pair: string;
  feeTvl24hPct: number | null;
  mcap: number | null;
  orgScore: number | null;
  binStep: number | null;
  baseFeePct: number | null;
  liquidity: number | null;
  volume24h: number | null;
  fee24h: number | null;
  holders: number | null;
}

/** One top-LP wallet row inside a pool's ?tab=top view. */
export interface LpAgentTopLp {
  wallet: string;
  poolAddress: string;
  deposited: number | null;
  pnl: number | null;
  feeEarned: number | null;
  rangeLabel: string | null; // lpagent's tight/normal/wide label — for calibration
}

/** A pool card as delivered by the browser: full address (from href) + innerText. */
export interface PoolCardCapture {
  address: string;
  text: string;
}

/** One wallet row scraped from /smart-lp (the leaderboard — discovery source). */
export interface SmartLpWallet {
  address: string;
  winRate: number | null;
  feeEarned: number | null;   // SOL
  totalPools: number | null;
  avgAgeHours: number | null;
  avgInvested: number | null; // SOL
  avgMonthlyProfit: number | null; // SOL
  d7: [number | null, number | null];  // [positions, profitSol]
  d30: [number | null, number | null];
  all: [number | null, number | null];
  firstActivity: string | null;
}

/** A smart-lp page as delivered by the browser: rendered innerText + ordered addrs. */
export interface SmartLpCapture {
  pageText: string;
  addresses: string[]; // full wallet addresses, in DOM order (from /portfolio?address= hrefs)
}

/**
 * The browser surface the adapter needs. Backed by Playwright in production, or a
 * fixture-fed fake in tests. Keeping DOM access behind this interface means the
 * parsers stay pure and unit-testable without a live browser.
 */
export interface ScrapeBrowser {
  /** Load /pools and return each pool card's {address, innerText}. */
  poolCards(url: string): Promise<PoolCardCapture[]>;
  /** Load a /smart-lp page and return its rendered text + ordered wallet addrs. */
  smartLpPage(url: string): Promise<SmartLpCapture>;
}

export class LpAgentClient implements AggregatorSource {
  constructor(private readonly browser: ScrapeBrowser) {}

  async listTopPools(): Promise<LpAgentPool[]> {
    const cards = await this.browser.poolCards("https://app.lpagent.io/pools");
    return cards.map((c) => parsePoolCard(c.address, c.text));
  }

  /**
   * Discovery: paginate /smart-lp and return every wallet found. Stops when a page
   * yields no wallets or maxPages is hit. Runs polite delays via the browser driver.
   */
  async discoverWallets(opts: { maxPages?: number } = {}): Promise<SmartLpWallet[]> {
    const maxPages = opts.maxPages ?? 30;
    const seen = new Set<string>();
    const out: SmartLpWallet[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const cap = await this.browser.smartLpPage(
        `https://app.lpagent.io/smart-lp?page=${page}`,
      );
      const rows = parseSmartLpPage(cap.pageText, cap.addresses);
      if (rows.length === 0) break; // past the last page
      let fresh = 0;
      for (const r of rows) {
        if (seen.has(r.address)) continue;
        seen.add(r.address);
        out.push(r);
        fresh++;
      }
      // If a page returned only already-seen wallets, we've wrapped — stop.
      if (fresh === 0) break;
    }
    return out;
  }

  async getWalletMetrics(
    wallet: string,
  ): Promise<Partial<{ winRate: number; feeEarned: number }>> {
    void wallet;
    return {};
  }
}

/**
 * Pure parser for a /smart-lp page. Segments the rendered innerText by the "Win Rate"
 * label (one per wallet card) and zips the segments with the ordered wallet addresses
 * captured from the /portfolio?address= links. Skips the sort-control "Win Rate" false
 * hit (a real card always has a MM/DD/YYYY First Activity). Verified live 2026-07-15.
 */
export function parseSmartLpPage(pageText: string, addresses: string[]): SmartLpWallet[] {
  const numFrom = (s: string | null): number | null => {
    if (s == null) return null;
    const m = s.replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]!) : null;
  };
  const lines = pageText.split("\n").map((s) => s.trim());
  const starts: number[] = [];
  lines.forEach((l, i) => l === "Win Rate" && starts.push(i));
  const after = (seg: string[], label: string) => {
    const i = seg.findIndex((l) => l.toLowerCase() === label.toLowerCase());
    return i >= 0 && i + 1 < seg.length ? seg[i + 1]! : null;
  };
  const tf = (seg: string[], label: string): [number | null, number | null] => {
    const i = seg.findIndex((l) => l === label);
    return i >= 0 ? [numFrom(seg[i + 1] ?? null), numFrom(seg[i + 2] ?? null)] : [null, null];
  };
  const out: SmartLpWallet[] = [];
  let ai = 0;
  for (let k = 0; k < starts.length; k++) {
    const seg = lines.slice(starts[k]!, starts[k + 1] ?? lines.length).filter(Boolean);
    const fa = after(seg, "First Activity");
    if (!fa || !/\d{2}\/\d{2}\/\d{4}/.test(fa)) continue; // skip sort-control false hit
    const address = addresses[ai++];
    if (!address) continue;
    out.push({
      address,
      winRate: numFrom(after(seg, "Win Rate")),
      feeEarned: numFrom(after(seg, "Fee Earned")),
      totalPools: numFrom(after(seg, "Total Pools")),
      avgAgeHours: numFrom(after(seg, "Avg Age")),
      avgInvested: numFrom(after(seg, "Avg Invested")),
      avgMonthlyProfit: numFrom(after(seg, "Avg Monthly Profit")),
      d7: tf(seg, "7D"),
      d30: tf(seg, "30D"),
      all: tf(seg, "ALL"),
      firstActivity: fa,
    });
  }
  return out;
}

// --- pure parsers (verified against __fixtures__) -----------------------------

/** Parse "$367.50k" / "1,930,000" / "3.69%" / "88" into a number. */
export function parseMetric(s: string | null | undefined): number | null {
  if (s == null) return null;
  const m = String(s).replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)\s*([kmb%])?/i);
  if (!m) return null;
  let v = parseFloat(m[1]!);
  switch ((m[2] ?? "").toLowerCase()) {
    case "k": v *= 1e3; break;
    case "m": v *= 1e6; break;
    case "b": v *= 1e9; break;
  }
  return v;
}

/** Value on the line following a stable label within a card's innerText lines. */
export function valueAfterLabel(lines: string[], label: string): string | null {
  const i = lines.findIndex((l) => l.trim().toLowerCase() === label.toLowerCase());
  return i >= 0 && i + 1 < lines.length ? lines[i + 1]!.trim() : null;
}

export function parsePoolCard(address: string, innerText: string): LpAgentPool {
  const lines = innerText.split("\n").map((s) => s.trim()).filter(Boolean);
  // pair: the line right after the "DLMM" tag, else first "X / Y" line.
  const dlmmIdx = lines.findIndex((l) => l === "DLMM");
  const pair =
    (dlmmIdx >= 0 ? lines[dlmmIdx + 1] : undefined) ??
    lines.find((l) => l.includes(" / ")) ??
    "";
  return {
    poolAddress: address,
    pair,
    feeTvl24hPct: parseMetric(valueAfterLabel(lines, "24h Fee/TVL")),
    mcap: parseMetric(valueAfterLabel(lines, "MCAP")),
    orgScore: parseMetric(valueAfterLabel(lines, "Org Score")),
    binStep: parseMetric(valueAfterLabel(lines, "Bin Step")),
    baseFeePct: parseMetric(valueAfterLabel(lines, "Base Fee")),
    liquidity: parseMetric(valueAfterLabel(lines, "Liquidity")),
    volume24h: parseMetric(valueAfterLabel(lines, "Volume (24h)")),
    fee24h: parseMetric(valueAfterLabel(lines, "Fee (24h)")),
    holders: parseMetric(valueAfterLabel(lines, "Holders")),
  };
}
