// Meteora datapi adapter — per-wallet / per-pool PnL and pool metadata (bin step).
//
// Base discovered from bengbeng.app's bundle: https://dlmm.datapi.meteora.ag
// It is a plain JSON API with open CORS (works server-side too — no scraping, no
// Cloudflare). PnL is returned in BOTH USD and SOL, so the currency toggle is free.
//
// There is NO "list a wallet's positions" endpoint on datapi. The real pipeline
// (as bengbeng does it): enumerate the wallet's DLMM position accounts via RPC
// getProgramAccounts on the free public node, collect the pools, then hit datapi
// per pool for PnL. Pool accounts / datapi carry `bin_step`, which drives the
// wide/normal/tight classification (median bin step across the wallet's pools).

export const DATAPI_BASE =
  process.env.METEORA_DATAPI ?? "https://dlmm.datapi.meteora.ag";

export const PUBLIC_RPC =
  process.env.SOLANA_RPC ?? "https://solana-rpc.publicnode.com";

/** Meteora DLMM program id (constant). */
export const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

export interface PoolPnl {
  poolAddress: string;
  wallet: string;
  totalPnlUsd: number;
  totalPnlSol: number;
  positionCount: number;
  /** Position open timestamps (unix seconds) — feeds session classification. */
  openTimes: number[];
  /** Per-position [lowerBinId, upperBinId] — feeds bin-span range width. */
  binRanges: Array<[number, number]>;
  /** Per-position rows (pnl, deposit, timestamps) — feeds wallet analytics. */
  rows: PositionRow[];
}

interface DatapiPosition {
  pnlUsd?: string; pnlSol?: string;
  lowerBinId?: number; upperBinId?: number;
  createdAt?: number; closedAt?: number | null; isClosed?: boolean;
  allTimeDeposits?: { total?: { usd?: string; sol?: string } };
}
interface DatapiPnlResp {
  totalCount?: number; hasNext?: boolean; positions?: DatapiPosition[];
}

/** One parsed position — the unit of on-chain per-wallet analytics. */
export interface PositionRow {
  pnlUsd: number; pnlSol: number;
  depositUsd: number; depositSol: number;
  createdAt: number; closedAt: number | null;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`datapi ${res.status} ${url}`);
  return res.json();
}

/**
 * A wallet's positions in a pool with PnL, from /positions/{pool}/pnl?user=.
 * DEEP: paginates ALL positions (open + closed) — a wallet often has dozens of
 * closed positions per pool, and page-1-only badly undercounts lifetime PnL.
 * `maxPages` bounds runaway pools.
 */
export async function getPoolPnl(
  pool: string,
  wallet: string,
  maxPages = 50,
): Promise<PoolPnl> {
  let totalPnlUsd = 0;
  let totalPnlSol = 0;
  let positionCount = 0;
  const openTimes: number[] = [];
  const binRanges: Array<[number, number]> = [];
  const rows: PositionRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const j = (await getJson(
      `${DATAPI_BASE}/positions/${pool}/pnl?user=${wallet}&page=${page}`,
    )) as DatapiPnlResp;
    const positions = j.positions ?? [];
    for (const p of positions) {
      const pnlUsd = Number(p.pnlUsd ?? 0);
      const pnlSol = Number(p.pnlSol ?? 0);
      totalPnlUsd += pnlUsd;
      totalPnlSol += pnlSol;
      positionCount++;
      if (p.createdAt) openTimes.push(p.createdAt);
      if (p.lowerBinId != null && p.upperBinId != null) {
        binRanges.push([p.lowerBinId, p.upperBinId]);
      }
      rows.push({
        pnlUsd, pnlSol,
        depositUsd: Number(p.allTimeDeposits?.total?.usd ?? 0),
        depositSol: Number(p.allTimeDeposits?.total?.sol ?? 0),
        createdAt: p.createdAt ?? 0,
        closedAt: p.closedAt ?? null,
      });
    }
    if (!j.hasNext) break;
  }
  return { poolAddress: pool, wallet, totalPnlUsd, totalPnlSol, positionCount, openTimes, binRanges, rows };
}

import { Connection, PublicKey } from "@solana/web3.js";
import { getUsdPrices } from "./jupiter.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/**
 * Complete token valuation — the wallet's current SPL holdings priced in USD via
 * Jupiter. Complements DLMM PnL with net token worth (what they're holding now).
 */
export async function getWalletHoldingsUsd(
  wallet: string,
): Promise<{ totalUsd: number; holdings: Array<{ mint: string; amount: number; usd: number }> }> {
  const conn = new Connection(PUBLIC_RPC, "confirmed");
  const resp = await conn.getParsedTokenAccountsByOwner(new PublicKey(wallet), {
    programId: TOKEN_PROGRAM,
  });
  const balances = new Map<string, number>();
  for (const { account } of resp.value) {
    const info = (account.data as { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } }).parsed.info;
    const amt = info.tokenAmount.uiAmount ?? 0;
    if (amt > 0) balances.set(info.mint, (balances.get(info.mint) ?? 0) + amt);
  }
  const prices = await getUsdPrices([...balances.keys()]);
  let totalUsd = 0;
  const holdings: Array<{ mint: string; amount: number; usd: number }> = [];
  for (const [mint, amount] of balances) {
    const usd = amount * (prices.get(mint) ?? 0);
    totalUsd += usd;
    holdings.push({ mint, amount, usd });
  }
  holdings.sort((a, b) => b.usd - a.usd);
  return { totalUsd, holdings };
}

// DLMM PositionV2 account layout: discriminator(8) | lbPair(32) | owner(32) | ...
// So owner is filterable at offset 40, and the pool (lbPair) is read at offset 8.
const POS_OWNER_OFFSET = 40;
const POS_LBPAIR_OFFSET = 8;

/**
 * Enumerate the pools a wallet currently has DLMM positions in, via RPC
 * getProgramAccounts with an owner memcmp filter.
 *
 * IMPORTANT (verified 2026-07-15): the free public node
 * (solana-rpc.publicnode.com) DISABLES getProgramAccounts ("RPC call disabled").
 * This needs a getProgramAccounts-enabled endpoint — set SOLANA_RPC to a Helius
 * URL (free tier allows it with an api-key) or another full node. The code below
 * is otherwise complete: it returns the deduped pool addresses.
 */
export async function getWalletPools(wallet: string): Promise<string[]> {
  const conn = new Connection(PUBLIC_RPC, "confirmed");
  const accounts = await conn.getProgramAccounts(new PublicKey(METEORA_DLMM_PROGRAM), {
    filters: [{ memcmp: { offset: POS_OWNER_OFFSET, bytes: wallet } }],
    dataSlice: { offset: POS_LBPAIR_OFFSET, length: 32 },
  });
  const pools = new Set<string>();
  for (const { account } of accounts) {
    pools.add(new PublicKey(account.data).toBase58());
  }
  return [...pools];
}

/**
 * #3 — aggregate a wallet's live PnL (USD + SOL) across its open-position pools,
 * and collect position open-times (for session classification) + bin ranges.
 */
export async function getWalletPnl(
  wallet: string,
  pools: string[],
): Promise<{ pnlUsd: number; pnlSol: number; openTimes: number[] }> {
  let pnlUsd = 0;
  let pnlSol = 0;
  const openTimes: number[] = [];
  for (const pool of pools) {
    try {
      const p = await getPoolPnl(pool, wallet);
      pnlUsd += p.totalPnlUsd;
      pnlSol += p.totalPnlSol;
      openTimes.push(...p.openTimes);
    } catch {
      /* skip pools datapi can't price */
    }
  }
  return { pnlUsd, pnlSol, openTimes };
}

/** PositionV2 account discriminator (first 8 bytes) — identifies DLMM positions. */
const POSITION_V2_DISCRIMINATOR = "75b0d4c7f5b485b6";

function base58Encode(buf: Uint8Array): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const d: number[] = [0];
  for (const b of buf) {
    let c = b;
    for (let j = 0; j < d.length; j++) { c += d[j]! << 8; d[j] = c % 58; c = (c / 58) | 0; }
    while (c) { d.push(c % 58); c = (c / 58) | 0; }
  }
  let s = "";
  for (const b of buf) { if (b === 0) s += "1"; else break; }
  return s + d.reverse().map((x) => A[x]).join("");
}

/**
 * DIRECT wallet enumeration — the whole Meteora DLMM LP universe in one shot.
 * getProgramAccounts on the DLMM program, filtered to PositionV2 accounts, reading
 * only each position's owner (offset 40). Deduped owners = EVERY wallet with an open
 * DLMM position right now (~88k, in seconds). Far superior to sweeping pools: no
 * swap noise, no overlap, no plateau. (Only OPEN positions — closed-only wallets are
 * still picked up by the pool/stream discovery + accumulate over time.)
 */
export async function discoverAllOpenPositionWallets(): Promise<string[]> {
  const discB58 = base58Encode(Buffer.from(POSITION_V2_DISCRIMINATOR, "hex"));
  const body = {
    jsonrpc: "2.0", id: 1, method: "getProgramAccounts",
    params: [METEORA_DLMM_PROGRAM, {
      encoding: "base64",
      dataSlice: { offset: 40, length: 32 }, // owner only
      filters: [{ memcmp: { offset: 0, bytes: discB58 } }],
    }],
  };
  const r = await fetch(PUBLIC_RPC, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = (await r.json()) as { result?: Array<{ account: { data: [string, string] } }>; error?: { message?: string } };
  if (j.error) throw new Error(`getProgramAccounts: ${j.error.message}`);
  const owners = new Set<string>();
  for (const a of j.result ?? []) {
    owners.add(base58Encode(Buffer.from(a.account.data[0], "base64")));
  }
  return [...owners];
}

/** Most active pools by 24h volume, from datapi's pool list (with bin step). */
export async function getActivePools(
  limit = 50,
): Promise<Array<{ address: string; binStep: number | null; vol24h: number; name: string }>> {
  // datapi returns 10 pools/page (ignores &limit), so page through to reach `limit`.
  const pools: Array<{ address: string; binStep: number | null; vol24h: number; name: string }> = [];
  const maxPages = Math.ceil(limit / 10) + 2;
  for (let page = 1; page <= maxPages; page++) {
    const j = (await getJson(`${DATAPI_BASE}/pools?page=${page}`)) as {
      data?: Array<{ address: string; name?: string; pool_config?: { bin_step?: number }; volume?: Record<string, number> }>;
    };
    const data = j.data ?? [];
    if (data.length === 0) break;
    for (const p of data) {
      pools.push({
        address: p.address,
        binStep: p.pool_config?.bin_step ?? null,
        vol24h: p.volume?.["24h"] ?? 0,
        name: p.name ?? "?",
      });
    }
  }
  return pools.sort((a, b) => b.vol24h - a.vol24h).slice(0, limit);
}

/**
 * LPs of a single pool — feePayers of the pool's non-swap txs (add/remove/claim).
 * Cleaner than the program-wide stream: these are wallets actually LPing THIS pool.
 */
export async function discoverPoolLps(pool: string, pages = 2): Promise<string[]> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY not set");
  const wallets = new Set<string>();
  let before: string | undefined;
  for (let i = 0; i < pages; i++) {
    const url =
      `https://api.helius.xyz/v0/addresses/${pool}/transactions/` +
      `?api-key=${key}&limit=100${before ? `&before=${before}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const txs = (await res.json()) as Array<{ signature: string; type?: string; feePayer?: string }>;
    if (txs.length === 0) break;
    for (const t of txs) {
      if (t.type === "SWAP" || t.type === "SWAP_WITH_PRICE_IMPACT") continue;
      if (t.feePayer) wallets.add(t.feePayer);
    }
    before = txs[txs.length - 1]!.signature;
  }
  return [...wallets];
}

/**
 * "Any wallet playing today" — discovery from the live DLMM program tx stream.
 * The feePayer of a DLMM transaction is the acting wallet; excluding pure swaps
 * leaves LP-ish activity (add/remove/claim/position). Paginate a few pages per
 * pass and accumulate across the 24/7 loop → thousands of active wallets over time.
 * (The DLMM firehose is dense — ~100 txs ≈ 1 minute — so a few pages per pass is
 * plenty; coverage grows by running often, not by deep pagination.)
 */
export async function discoverActiveWallets(opts: { pages?: number } = {}): Promise<string[]> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY not set");
  const pages = opts.pages ?? 5;
  const wallets = new Set<string>();
  let before: string | undefined;
  for (let i = 0; i < pages; i++) {
    const url =
      `https://api.helius.xyz/v0/addresses/${METEORA_DLMM_PROGRAM}/transactions/` +
      `?api-key=${key}&limit=100${before ? `&before=${before}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const txs = (await res.json()) as Array<{ signature: string; type?: string; feePayer?: string }>;
    if (txs.length === 0) break;
    for (const t of txs) {
      if (t.type === "SWAP" || t.type === "SWAP_WITH_PRICE_IMPACT") continue;
      if (t.feePayer) wallets.add(t.feePayer);
    }
    before = txs[txs.length - 1]!.signature;
  }
  return [...wallets];
}

/**
 * DEEP lifetime PnL — the real "who made the most" number. Unions the wallet's
 * currently-open pools (RPC) with its historical pools (Helius tx-history), then
 * sums PnL across ALL positions (open + closed) in every pool. This is heavy
 * (pools × pages of positions), so run it for ranked candidates / incrementally,
 * not for every wallet every pass.
 */
export async function getWalletDeepPnl(
  wallet: string,
  opts: { historyPages?: number } = {},
): Promise<{ pnlUsd: number; pnlSol: number; positions: number; pools: number; openTimes: number[] }> {
  const open = await getWalletPools(wallet).catch(() => []);
  const hist = await getHistoricalPools(wallet, { pages: opts.historyPages ?? 5 }).catch(() => []);
  const pools = [...new Set([...open, ...hist])];
  let pnlUsd = 0;
  let pnlSol = 0;
  let positions = 0;
  const openTimes: number[] = [];
  let priced = 0;
  for (const pool of pools) {
    try {
      const p = await getPoolPnl(pool, wallet);
      pnlUsd += p.totalPnlUsd;
      pnlSol += p.totalPnlSol;
      positions += p.positionCount;
      openTimes.push(...p.openTimes);
      priced++;
    } catch {
      /* not a DLMM pool / datapi can't price — skip */
    }
  }
  return { pnlUsd, pnlSol, positions, pools: priced, openTimes };
}

export interface WalletAnalytics {
  totalPositions: number;
  totalPools: number;
  winRate: number | null;          // 0..1 (share of positions with pnl > 0)
  pnlUsd: number; pnlSol: number;   // lifetime
  avgInvestedSol: number | null;
  avgAgeHours: number | null;
  avgMonthlyProfitSol: number | null;
  firstActivity: number | null;     // unix ms
  lastActivity: number | null;
  openTimes: number[];              // for session classification
  binSteps: number[];               // for range classification (median)
}

/**
 * THE deep per-wallet analytics — computed entirely on-chain from datapi position
 * data, for ANY wallet (not just lpagent-scraped ones). Enumerates every pool the
 * wallet ever LP'd, pulls all positions, and derives win rate, avg invested, avg
 * hold age, lifetime PnL, monthly profit, first/last activity, plus the pools'
 * bin steps + open times for range/session. This is the "root analysis" layer.
 */
export async function getWalletAnalytics(
  wallet: string,
  opts: { historyPages?: number } = {},
): Promise<WalletAnalytics> {
  const open = await getWalletPools(wallet).catch(() => []);
  const hist = await getHistoricalPools(wallet, { pages: opts.historyPages ?? 30 }).catch(() => []);
  const pools = [...new Set([...open, ...hist])];
  const rows: PositionRow[] = [];
  const binSteps: number[] = [];
  let pricedPools = 0;
  for (const pool of pools) {
    try {
      const pp = await getPoolPnl(pool, wallet);
      if (pp.rows.length === 0) continue;
      rows.push(...pp.rows);
      pricedPools++;
      const bs = await getPoolBinStep(pool); // cached
      if (bs != null) binSteps.push(bs);
    } catch {
      /* not a DLMM pool — skip */
    }
  }

  const n = rows.length;
  const sum = (f: (r: PositionRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const wins = rows.filter((r) => r.pnlUsd > 0).length;
  const pnlSol = sum((r) => r.pnlSol);
  const deposits = rows.map((r) => r.depositSol).filter((x) => x > 0);
  const nowS = Date.now() / 1000;
  const ages = rows
    .filter((r) => r.createdAt > 0)
    .map((r) => ((r.closedAt ?? nowS) - r.createdAt) / 3600)
    .filter((x) => x >= 0);
  const created = rows.map((r) => r.createdAt).filter((x) => x > 0);
  const lastTs = rows.map((r) => r.closedAt ?? r.createdAt).filter((x) => x > 0);
  const firstActivity = created.length ? created.reduce((a, b) => Math.min(a, b)) * 1000 : null;
  const lastActivity = lastTs.length ? lastTs.reduce((a, b) => Math.max(a, b)) * 1000 : null;
  const monthsActive = firstActivity ? (Date.now() - firstActivity) / (30 * 86_400_000) : null;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    totalPositions: n,
    totalPools: pricedPools,
    winRate: n ? wins / n : null,
    pnlUsd: sum((r) => r.pnlUsd),
    pnlSol,
    avgInvestedSol: avg(deposits),
    avgAgeHours: avg(ages),
    avgMonthlyProfitSol: monthsActive && monthsActive > 0.03 ? pnlSol / monthsActive : null,
    firstActivity,
    lastActivity,
    openTimes: created,
    binSteps,
  };
}

const SYSTEM_ACCOUNTS = new Set([
  METEORA_DLMM_PROGRAM,
  "11111111111111111111111111111111", // System program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // ATA
  "ComputeBudget111111111111111111111111111111",
  "So11111111111111111111111111111111111111112", // wSOL mint
]);

/**
 * #1 — every pool a wallet has EVER LP'd, from Helius parsed tx-history.
 *
 * RELIABLE method (deterministic, catches EVERY pool incl. single-position ones):
 *   1. Paginate the FULL parsed tx-history, collecting every account touched by a
 *      DLMM instruction (no frequency filter — nothing dropped).
 *   2. Confirm which candidates are pools by their on-chain account DISCRIMINATOR:
 *      DLMM LbPair (pool) accounts start with `210b3162b565b10d` and are owned by
 *      the program. Pools are permanent, so this works for closed positions too.
 * This is more complete + reliable than frequency-guessing + datapi validation.
 */
const LBPAIR_DISCRIMINATOR = "210b3162b565b10d";
const _poolCheckCache = new Map<string, boolean>();

/** Every signature for a wallet (complete, via getSignaturesForAddress 1000/batch). */
async function getAllSignatures(wallet: string, maxSigs: number): Promise<string[]> {
  const sigs: string[] = [];
  let before: string | undefined;
  while (sigs.length < maxSigs) {
    const body = {
      jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
      params: [wallet, { limit: 1000, ...(before ? { before } : {}) }],
    };
    const r = await fetch(PUBLIC_RPC, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) break;
    const j = (await r.json()) as { result?: Array<{ signature: string }> };
    const a = j.result ?? [];
    if (a.length === 0) break;
    for (const s of a) sigs.push(s.signature);
    if (a.length < 1000) break;
    before = a[a.length - 1]!.signature;
  }
  return sigs;
}

export async function getHistoricalPools(
  wallet: string,
  opts: { pages?: number } = {},
): Promise<string[]> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY not set");
  // `pages` (× 100) bounds the signature walk for pathological wallets.
  const maxSigs = (opts.pages ?? 500) * 100;

  // 1) complete signature list, then batch-parse (100/call) — far more reliable
  //    than the paginated /addresses/{w}/transactions endpoint (which truncates).
  const sigs = await getAllSignatures(wallet, maxSigs);
  const candidates = new Set<string>();
  for (let i = 0; i < sigs.length; i += 100) {
    const r = await fetch(`https://api.helius.xyz/v0/transactions/?api-key=${key}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: sigs.slice(i, i + 100) }),
    });
    if (!r.ok) continue;
    const txs = (await r.json()) as Array<{
      instructions?: Array<{ programId?: string; accounts?: string[] }>;
    }>;
    for (const tx of txs) {
      for (const ix of tx.instructions ?? []) {
        if (ix.programId !== METEORA_DLMM_PROGRAM) continue;
        for (const acc of ix.accounts ?? []) {
          if (!SYSTEM_ACCOUNTS.has(acc) && acc !== wallet) candidates.add(acc);
        }
      }
    }
  }

  // 2) keep only accounts whose discriminator == LbPair (definitive pools)
  const conn = new Connection(PUBLIC_RPC, "confirmed");
  const toCheck = [...candidates].filter((a) => !_poolCheckCache.has(a));
  for (let i = 0; i < toCheck.length; i += 100) {
    const batch = toCheck.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(
      batch.map((a) => new PublicKey(a)),
      { dataSlice: { offset: 0, length: 8 } },
    );
    infos.forEach((info, idx) => {
      const isPool =
        !!info &&
        info.owner.toBase58() === METEORA_DLMM_PROGRAM &&
        Buffer.from(info.data).toString("hex") === LBPAIR_DISCRIMINATOR;
      _poolCheckCache.set(batch[idx]!, isPool);
    });
  }
  return [...candidates].filter((a) => _poolCheckCache.get(a));
}

/** Bin step for a pool from datapi metadata (nested under pool_config).
 *  Cached across the process — the same pools recur across many wallets, and this
 *  doubles as the pool/non-pool validator used by getHistoricalPools. */
const _binStepCache = new Map<string, number | null>();
export async function getPoolBinStep(pool: string): Promise<number | null> {
  const cached = _binStepCache.get(pool);
  if (cached !== undefined) return cached;
  let result: number | null = null;
  try {
    const j = (await getJson(`${DATAPI_BASE}/pools/${pool}`)) as {
      pool_config?: { bin_step?: number };
    };
    const bs = j.pool_config?.bin_step;
    result = bs == null ? null : Number(bs);
  } catch {
    result = null;
  }
  _binStepCache.set(pool, result);
  return result;
}
