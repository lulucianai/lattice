// Shared domain types for the DLMM wallet tracker.
// Kept dependency-free so both the ingest worker and the web app can import them.

/** How wide a range the wallet typically sets on its DLMM positions. */
export type RangeStyle = "tight" | "normal" | "wide" | "super_degen";

/** How the wallet operates: rotating single positions fast, or many at once. */
export type PlayType = "fast" | "multi";

/** Trading session inferred from the wallet's activity-hour distribution (UTC-based). */
export type SessionTz = "asia" | "london" | "ny" | "mixed";

export type Timeframe = "12h" | "24h" | "7d" | "30d" | "all";

/** A DLMM pool / token pair. */
export interface Pool {
  address: string;        // pool (lbPair) address
  name: string;           // e.g. "TOKEN-SOL"
  baseMint: string;
  quoteMint: string;
  baseSymbol: string;
  quoteSymbol: string;
  binStep: number;        // bps per bin — drives how a bin-span maps to a price-%
}

/** A single LP position a wallet opened in a pool. */
export interface Position {
  id: string;             // position NFT / account address
  wallet: string;
  pool: string;           // pool address
  openedAt: number;       // unix ms
  closedAt: number | null;
  deposited: number;      // USD deposited at open
  binSpan: number;        // number of bins covered (upper - lower + 1)
  // Realized so far (from on-chain claim + withdraw events):
  feesClaimed: number;    // USD
  pnl: number;            // USD (fees + price impact of range, realized/unrealized)
}

/** Point-in-time rollup for a wallet over a timeframe — powers the leaderboard. */
export interface WalletSnapshot {
  wallet: string;
  timeframe: Timeframe;
  capturedAt: number;     // unix ms
  totalPositions: number;
  totalProfit: number;    // USD
  feeEarned: number;      // USD
  avgInvested: number;    // USD
  winRate: number;        // 0..1
  isGreen: boolean;       // totalProfit > 0 over the timeframe
}

/** The classification the tracker assigns to each wallet from its behaviour. */
export interface WalletClassification {
  rangeStyle: RangeStyle;
  playType: PlayType;
  session: SessionTz;
}

export interface Wallet {
  address: string;
  customName: string | null;   // user-editable label (watchlist)
  starred: boolean;            // watchlisted
  firstActivity: number | null;
  lastActivity: number | null;
  classification: WalletClassification | null;
}
