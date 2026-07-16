// Adapter contract. Every data source (on-chain or scraped) implements a subset
// of this so the worker can treat them uniformly. This is the seam that isolates
// the "which exact endpoint / how it's fetched" uncertainty from the rest.

import type { Pool, Position } from "@lattice/core";

export interface PoolSource {
  /** List active DLMM pools (paginated by the source internally). */
  listPools(opts?: { limit?: number }): Promise<Pool[]>;
}

export interface WalletSource {
  /** Positions a wallet has opened/closed, derived from on-chain history. */
  getWalletPositions(wallet: string): Promise<Position[]>;
}

/** Aggregator scrape (hybrid): pre-computed metrics we don't derive ourselves. */
export interface AggregatorSource {
  /** Extra per-wallet stats keyed by address (e.g. historical win rate). */
  getWalletMetrics(
    wallet: string,
  ): Promise<Partial<{ winRate: number; feeEarned: number }>>;
}
