// Read access for the dashboard via Node's built-in SQLite.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

function dbPath() {
  if (process.env.LATTICE_DB) return process.env.LATTICE_DB;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(path.resolve(here, "../../../.."), "data", "lattice.sqlite");
}

let _db: DatabaseSync | null = null;
function db() {
  if (!_db) {
    _db = new DatabaseSync(dbPath());
    _db.exec("PRAGMA busy_timeout = 5000;"); // coexist with the worker's writes
  }
  return _db;
}

/** Watchlist star + custom name (write path for the leaderboard controls). */
export function updateWallet(address: string, patch: { starred?: boolean; customName?: string | null }) {
  if (patch.starred !== undefined) {
    db().prepare("UPDATE wallets SET starred = ? WHERE address = ?").run(patch.starred ? 1 : 0, address);
  }
  if (patch.customName !== undefined) {
    const name = patch.customName?.trim() || null;
    db().prepare("UPDATE wallets SET custom_name = ? WHERE address = ?").run(name, address);
  }
}

export type Timeframe = "12h" | "24h" | "7d" | "30d" | "all";

// Short windows (12h/24h) are DELTAS from our own scrape history — the friend's
// "latest snapshot" model. They only have values once the worker has taken ≥2
// snapshots that far apart; until then they read as null ("accumulating").
const WINDOW_HOURS: Partial<Record<Timeframe, number>> = { "12h": 12, "24h": 24 };

function windowDelta(wallet: string, hours: number): number | null {
  const cutoff = Date.now() - hours * 3_600_000;
  const rows = db()
    .prepare(
      `SELECT captured_at AS t, profit_all AS p FROM wallet_history
       WHERE wallet = ? ORDER BY captured_at DESC`,
    )
    .all(wallet) as Array<{ t: number; p: number | null }>;
  if (rows.length < 2) return null;
  const cur = rows[0]!;
  const past = rows.find((r) => r.t <= cutoff);
  if (!past || cur.p == null || past.p == null) return null;
  return cur.p - past.p;
}

export interface WalletRow {
  address: string;
  customName: string | null;
  starred: number;
  winRate: number | null;
  feeEarned: number | null;
  totalPools: number | null;
  ev: number | null;
  avgAgeHours: number | null;
  avgInvested: number | null;
  avgMonthlyProfit: number | null;
  tempo: string | null;
  playType: string | null;
  rangeStyle: string | null;
  session: string | null;
  pnlUsd: number | null;   // live PnL from Meteora datapi
  pnlSol: number | null;
  firstActivity: number | null;
  lastActivity: number | null;
  positions: number;
  profit: number; // SOL, for the selected timeframe
  profit7d: number | null;   // for the green-cohort column
  profit30d: number | null;
}

export function getLeaderboard(tf: Timeframe = "all"): WalletRow[] {
  try {
    // 7d/30d/all come straight from lpagent's snapshot; 12h/24h are our deltas.
    const snapTf = WINDOW_HOURS[tf] ? "all" : tf;
    const rows = db()
      .prepare(
        `SELECT w.address, w.custom_name AS customName, w.starred,
                w.win_rate AS winRate, w.fee_earned AS feeEarned, w.total_pools AS totalPools,
                w.ev, w.avg_age_hours AS avgAgeHours, w.avg_invested AS avgInvested,
                w.avg_monthly_profit AS avgMonthlyProfit, w.tempo, w.play_type AS playType,
                w.range_style AS rangeStyle, w.session,
                w.pnl_usd AS pnlUsd, w.pnl_sol AS pnlSol,
                w.first_activity AS firstActivity, w.last_activity AS lastActivity,
                COALESCE(s.positions,0) AS positions, COALESCE(s.profit,0) AS profit,
                (SELECT profit FROM wallet_snapshots WHERE wallet=w.address AND timeframe='7d') AS profit7d,
                (SELECT profit FROM wallet_snapshots WHERE wallet=w.address AND timeframe='30d') AS profit30d
         FROM wallets w
         LEFT JOIN wallet_snapshots s ON s.wallet = w.address AND s.timeframe = ?
         WHERE w.fee_earned IS NOT NULL OR w.pnl_usd IS NOT NULL OR w.range_style IS NOT NULL
         ORDER BY profit DESC`,
      )
      .all(snapTf) as unknown as WalletRow[];

    const hours = WINDOW_HOURS[tf];
    if (hours) {
      for (const r of rows) r.profit = windowDelta(r.address, hours) ?? 0;
      rows.sort((a, b) => b.profit - a.profit);
    }
    return rows;
  } catch {
    return [];
  }
}

export interface Overview {
  totalWallets: number;   // enriched (shown in leaderboard)
  discovered: number;     // all wallets discovered (incl. pending enrichment)
  activeToday: number;
  greenWallets: number;
  totalFee: number;        // SOL
  totalProfit: number;     // SOL, selected timeframe
  avgInvested: number;     // SOL
  avgMonthlyProfit: number;// SOL
  green7d: number;
  green30d: number;
  totalPositions: number;
}

export function getOverview(tf: Timeframe = "all"): Overview {
  const rows = getLeaderboard(tf);
  const rows7 = getLeaderboard("7d");
  const rows30 = getLeaderboard("30d");
  const dayMs = 86_400_000;
  const now = Date.now();
  const sum = (a: WalletRow[], f: (r: WalletRow) => number) => a.reduce((x, r) => x + f(r), 0);
  const discovered = (db().prepare("SELECT COUNT(*) n FROM wallets").get() as { n: number }).n;
  return {
    totalWallets: rows.length,
    discovered,
    activeToday: rows.filter((r) => r.lastActivity != null && now - r.lastActivity < dayMs).length,
    greenWallets: rows.filter((r) => r.profit > 0).length,
    totalFee: sum(rows, (r) => r.feeEarned ?? 0),
    totalProfit: sum(rows, (r) => r.profit),
    avgInvested: rows.length ? sum(rows, (r) => r.avgInvested ?? 0) / rows.length : 0,
    avgMonthlyProfit: sum(rows, (r) => r.avgMonthlyProfit ?? 0),
    green7d: rows7.filter((r) => r.profit > 0).length,
    green30d: rows30.filter((r) => r.profit > 0).length,
    totalPositions: sum(rows, (r) => r.positions),
  };
}
