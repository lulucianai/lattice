// Playstyle classification — the core idea of the tracker.
//
// These heuristics are computed purely from on-chain behaviour. The thresholds
// are intentionally exported so they can be CALIBRATED against a reference
// aggregator (lpagent) during the hybrid ingest step, rather than hard-guessed.

import type {
  Pool,
  Position,
  PlayType,
  RangeStyle,
  SessionTz,
  WalletClassification,
} from "./types.js";

/**
 * Range width thresholds, expressed as the price-% a position's bin span covers.
 * A DLMM position spanning `binSpan` bins of `binStep` bps covers roughly
 * `binSpan * binStep / 100` percent of price (compounded, but this is close
 * enough for bucketing).
 */
export const RANGE_THRESHOLDS = {
  tight: 3,        // <= 3%   → tight
  normal: 12,      // <= 12%  → normal
  wide: 40,        // <= 40%  → wide
  // > 40% → super_degen
} as const;

/** Approx price-% covered by a bin span at a given bin step (bps). */
export function binSpanToPricePct(binSpan: number, binStepBps: number): number {
  return (binSpan * binStepBps) / 100;
}

export function classifyRangeStyle(pricePct: number): RangeStyle {
  if (pricePct <= RANGE_THRESHOLDS.tight) return "tight";
  if (pricePct <= RANGE_THRESHOLDS.normal) return "normal";
  if (pricePct <= RANGE_THRESHOLDS.wide) return "wide";
  return "super_degen";
}

export const PLAYTYPE_THRESHOLDS = {
  /** Median position hold below this (hours) leans "fast". */
  fastHoldHours: 6,
  /** Avg concurrent open positions at/above this leans "multi". */
  multiConcurrent: 3,
} as const;

/**
 * fast  = short average hold, rotating one position at a time
 * multi = many positions open simultaneously
 * When both signals fire, "multi" wins (managing many is the dominant trait).
 */
export function classifyPlayType(
  medianHoldHours: number,
  avgConcurrent: number,
): PlayType {
  if (avgConcurrent >= PLAYTYPE_THRESHOLDS.multiConcurrent) return "multi";
  if (medianHoldHours <= PLAYTYPE_THRESHOLDS.fastHoldHours) return "fast";
  // Default: whichever is relatively more pronounced.
  return avgConcurrent >= 2 ? "multi" : "fast";
}

/**
 * Trading-session boundaries in UTC hours. Rough but standard FX-session windows:
 *   Asia   ~00:00–08:00 UTC
 *   London ~07:00–16:00 UTC
 *   NY     ~13:00–21:00 UTC
 * Overlaps are intentional; the dominant bucket wins.
 */
export function classifySession(activityHoursUtc: number[]): SessionTz {
  if (activityHoursUtc.length === 0) return "mixed";
  const buckets = { asia: 0, london: 0, ny: 0 };
  for (const h of activityHoursUtc) {
    const hh = ((h % 24) + 24) % 24;
    if (hh >= 0 && hh < 8) buckets.asia++;
    if (hh >= 7 && hh < 16) buckets.london++;
    if (hh >= 13 && hh < 21) buckets.ny++;
  }
  const total = activityHoursUtc.length;
  const entries = Object.entries(buckets) as [SessionTz, number][];
  entries.sort((a, b) => b[1] - a[1]);
  const [topTz, topCount] = entries[0]!;
  const [, secondCount] = entries[1]!;
  // If no bucket clearly dominates (>45% and clearly ahead), call it mixed.
  if (topCount / total < 0.45 || topCount - secondCount < total * 0.1) {
    return "mixed";
  }
  return topTz;
}

/** Full classification from a wallet's positions + the pools they traded. */
export function classifyWallet(
  positions: Position[],
  poolsByAddress: Map<string, Pool>,
): WalletClassification | null {
  if (positions.length === 0) return null;

  // Range style: median price-% across positions.
  const pricePcts = positions
    .map((p) => {
      const pool = poolsByAddress.get(p.pool);
      if (!pool) return null;
      return binSpanToPricePct(p.binSpan, pool.binStep);
    })
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  const medianPct = pricePcts.length
    ? pricePcts[Math.floor(pricePcts.length / 2)]!
    : RANGE_THRESHOLDS.normal;

  // Hold durations (closed positions only).
  const holds = positions
    .filter((p) => p.closedAt != null)
    .map((p) => (p.closedAt! - p.openedAt) / 3_600_000)
    .sort((a, b) => a - b);
  const medianHold = holds.length ? holds[Math.floor(holds.length / 2)]! : 24;

  // Avg concurrency: max overlapping open intervals, sampled cheaply as
  // positions-per-active-day. Refined later with an interval sweep.
  const avgConcurrent = estimateConcurrency(positions);

  // Session: hour-of-day of every open event.
  const hours = positions.map((p) => new Date(p.openedAt).getUTCHours());

  return {
    rangeStyle: classifyRangeStyle(medianPct),
    playType: classifyPlayType(medianHold, avgConcurrent),
    session: classifySession(hours),
  };
}

// --- classification derivable from lpagent smart-lp fields alone --------------
// NOTE: true range style (tight/normal/wide/super_degen) and trading session need
// per-position Range bounds (portfolio scrape) and open timestamps (on-chain) —
// they are enriched later. What smart-lp gives us cleanly is HOLD TEMPO (from avg
// position age) and a fast/multi lean (from age + pool breadth).

/**
 * Range style from Meteora BIN STEP (user-specified rule): default/normal ≈ 70 bps.
 * Decide from the wallet's OVERALL pattern — the median bin step across all their
 * positions — not a single position. Below 70 = tighter ranges; above = wider.
 * `super_degen` is reserved for extreme bin steps (very wide, high-risk plays).
 * Thresholds are exported for calibration.
 */
// Calibrated to the real bin-step distribution seen on-chain:
//   stables/majors sit LOW (SOL-USDC=4, ANSEM=20), memecoins HIGH (100/125), and
//   degen pairs higher (200/400). User's rule (normal≈70) is honored as the middle.
export const BIN_STEP_BANDS = {
  tightBelow: 40,   // median bin step < 40   → tight   (stables/majors: 1–25)
  normalUpTo: 90,   // 40–90                  → normal  (50, 80; 70 is the center)
  wideUpTo: 250,    // 90–250                 → wide    (100, 125, 200)
  // > 250                                    → super_degen (400+)
} as const;

export function classifyRangeByBinStep(medianBinStep: number | null): RangeStyle | null {
  if (medianBinStep == null) return null;
  if (medianBinStep < BIN_STEP_BANDS.tightBelow) return "tight";
  if (medianBinStep <= BIN_STEP_BANDS.normalUpTo) return "normal";
  if (medianBinStep <= BIN_STEP_BANDS.wideUpTo) return "wide";
  return "super_degen";
}

/** Median of a numeric list (bin steps across a wallet's positions). */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export type Tempo = "scalp" | "intraday" | "swing" | "position";

export const TEMPO_THRESHOLDS = {
  scalp: 1, // avg age (hrs) <= 1  → scalp
  intraday: 8, // <= 8  → intraday
  swing: 48, // <= 48 → swing ; else position
} as const;

export function classifyTempo(avgAgeHours: number | null): Tempo | null {
  if (avgAgeHours == null) return null;
  if (avgAgeHours <= TEMPO_THRESHOLDS.scalp) return "scalp";
  if (avgAgeHours <= TEMPO_THRESHOLDS.intraday) return "intraday";
  if (avgAgeHours <= TEMPO_THRESHOLDS.swing) return "swing";
  return "position";
}

/**
 * fast vs multi from smart-lp breadth:
 *   fast  = short holds, rotating a handful of pools
 *   multi = spread across many pools at once
 * `totalPools` is the count of distinct pools the wallet has LP'd — a good proxy
 * for how "multi" they play. Threshold is tunable / calibratable.
 */
export function classifyPlayTypeFromBreadth(
  avgAgeHours: number | null,
  totalPools: number | null,
): PlayType | null {
  if (totalPools == null && avgAgeHours == null) return null;
  if ((totalPools ?? 0) >= 250) return "multi";
  if ((avgAgeHours ?? 99) <= 2) return "fast";
  return (totalPools ?? 0) >= 120 ? "multi" : "fast";
}

/** Max number of positions open at the same instant (interval sweep). */
export function estimateConcurrency(positions: Position[]): number {
  const events: [number, number][] = [];
  for (const p of positions) {
    events.push([p.openedAt, +1]);
    events.push([p.closedAt ?? Date.now(), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, delta] of events) {
    cur += delta;
    if (cur > max) max = cur;
  }
  return max;
}
