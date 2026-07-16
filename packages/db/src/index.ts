// DB layer built on Node's built-in SQLite (node:sqlite) — no native compile.
// Values that come from lpagent smart-lp are SOL-denominated (profit, fees,
// invested). USD conversion is applied at read time with a SOL price when set.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface WalletRow {
  address: string;
  customName: string | null;
  starred: number;
  source: string | null;
  // current metrics (lpagent smart-lp)
  winRate: number | null;        // %
  feeEarned: number | null;      // SOL
  totalPools: number | null;
  ev: number | null;             // SOL
  avgAgeHours: number | null;
  avgInvested: number | null;    // SOL
  avgMonthlyProfit: number | null; // SOL
  // classification
  tempo: string | null;          // scalp | intraday | swing | position
  playType: string | null;       // fast | multi (derived)
  rangeStyle: string | null;     // tight | normal | wide | super_degen (portfolio enrich)
  session: string | null;        // asia | london | ny | mixed (timestamp enrich)
  // #3 — live PnL from Meteora datapi (open positions), USD + SOL
  pnlUsd: number | null;
  pnlSol: number | null;
  // TIER-1 signal from the free census (no per-wallet calls)
  openPositions: number | null;
  openPools: number | null;
  /** How deeply this wallet has been analysed: 0/null=none, 1=quick, 2=deep. */
  tier: number | null;
  firstActivity: number | null;
  lastActivity: number | null;
}

export interface SnapshotInput {
  wallet: string;
  timeframe: string; // 7d | 30d | all
  positions: number;
  profit: number;    // SOL
}

const DB_PATH = process.env.LATTICE_DB ?? defaultDbPath();
function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "../../..");
  return path.join(root, "data", "lattice.sqlite");
}

let _db: DatabaseSync | null = null;
export function getDb(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec("PRAGMA busy_timeout = 5000;"); // Python scraper + Node worker both write

  ensureTables(_db);
  return _db;
}

export function ensureTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY,
      custom_name TEXT,
      starred INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      win_rate REAL,
      fee_earned REAL,
      total_pools INTEGER,
      ev REAL,
      avg_age_hours REAL,
      avg_invested REAL,
      avg_monthly_profit REAL,
      tempo TEXT,
      play_type TEXT,
      range_style TEXT,
      session TEXT,
      pnl_usd REAL,
      pnl_sol REAL,
      open_positions INTEGER,
      open_pools INTEGER,
      tier INTEGER,
      first_activity INTEGER,
      last_activity INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE IF NOT EXISTS wallet_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      positions INTEGER NOT NULL DEFAULT 0,
      profit REAL NOT NULL DEFAULT 0,
      UNIQUE(wallet, timeframe)
    );
    CREATE INDEX IF NOT EXISTS snap_tf_profit_idx ON wallet_snapshots(timeframe, profit);
    -- Time-series of cumulative stats per scrape. The 12h/24h windows are DELTAS
    -- computed from this history (the friend's "latest snapshot" model). lpagent's
    -- own 7d/30d/all live in wallet_snapshots; short windows are ours to compute.
    CREATE TABLE IF NOT EXISTS wallet_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      profit_all REAL,
      fee_earned REAL,
      positions_all INTEGER
    );
    CREATE INDEX IF NOT EXISTS hist_wallet_time_idx ON wallet_history(wallet, captured_at);
  `);
  migrate(db);
}

/** Add columns introduced after a DB was first created (keeps existing rows). */
function migrate(db: DatabaseSync) {
  const columns: Array<[string, string]> = [
    ["open_positions", "INTEGER"],
    ["open_pools", "INTEGER"],
    ["tier", "INTEGER"],
  ];
  for (const [name, type] of columns) {
    try {
      db.exec(`ALTER TABLE wallets ADD COLUMN ${name} ${type}`);
    } catch {
      /* already exists — fine */
    }
  }
  // ranking indexes for the tiered enrichment funnel
  try {
    db.exec("CREATE INDEX IF NOT EXISTS wallets_tier_idx ON wallets(tier)");
    db.exec("CREATE INDEX IF NOT EXISTS wallets_openpos_idx ON wallets(open_positions DESC)");
  } catch {
    /* ignore */
  }
}

/** Record one point in a wallet's cumulative-stats time series (per scrape). */
export function recordHistory(h: {
  wallet: string;
  profitAll: number | null;
  feeEarned: number | null;
  positionsAll: number | null;
}) {
  getDb()
    .prepare(
      `INSERT INTO wallet_history (wallet, captured_at, profit_all, fee_earned, positions_all)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(h.wallet, Date.now(), h.profitAll, h.feeEarned, h.positionsAll);
}

/**
 * Profit delta over the last `hours`: current cumulative profit minus the nearest
 * snapshot at/just before (now − hours). Returns null when there isn't enough
 * history yet (the window is still "accumulating").
 */
export function getWindowDelta(wallet: string, hours: number): number | null {
  const cutoff = Date.now() - hours * 3_600_000;
  const rows = getDb()
    .prepare(
      `SELECT captured_at AS t, profit_all AS p FROM wallet_history
       WHERE wallet = ? ORDER BY captured_at DESC`,
    )
    .all(wallet) as Array<{ t: number; p: number | null }>;
  if (rows.length < 2) return null;
  const current = rows[0]!;
  const past = rows.find((r) => r.t <= cutoff);
  if (!past || current.p == null || past.p == null) return null;
  return current.p - past.p;
}

export function upsertWallet(w: Partial<WalletRow> & { address: string }) {
  getDb()
    .prepare(
      `INSERT INTO wallets
        (address, custom_name, starred, source, win_rate, fee_earned, total_pools,
         ev, avg_age_hours, avg_invested, avg_monthly_profit, tempo, play_type,
         range_style, session, pnl_usd, pnl_sol, open_positions, open_pools, tier,
         first_activity, last_activity)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(address) DO UPDATE SET
         source=COALESCE(excluded.source, wallets.source),
         win_rate=COALESCE(excluded.win_rate, wallets.win_rate),
         fee_earned=COALESCE(excluded.fee_earned, wallets.fee_earned),
         total_pools=COALESCE(excluded.total_pools, wallets.total_pools),
         ev=COALESCE(excluded.ev, wallets.ev),
         avg_age_hours=COALESCE(excluded.avg_age_hours, wallets.avg_age_hours),
         avg_invested=COALESCE(excluded.avg_invested, wallets.avg_invested),
         avg_monthly_profit=COALESCE(excluded.avg_monthly_profit, wallets.avg_monthly_profit),
         tempo=COALESCE(excluded.tempo, wallets.tempo),
         play_type=COALESCE(excluded.play_type, wallets.play_type),
         range_style=COALESCE(excluded.range_style, wallets.range_style),
         session=COALESCE(excluded.session, wallets.session),
         pnl_usd=COALESCE(excluded.pnl_usd, wallets.pnl_usd),
         pnl_sol=COALESCE(excluded.pnl_sol, wallets.pnl_sol),
         open_positions=COALESCE(excluded.open_positions, wallets.open_positions),
         open_pools=COALESCE(excluded.open_pools, wallets.open_pools),
         tier=COALESCE(excluded.tier, wallets.tier),
         first_activity=COALESCE(excluded.first_activity, wallets.first_activity),
         last_activity=COALESCE(excluded.last_activity, wallets.last_activity),
         updated_at=unixepoch()*1000`,
    )
    .run(
      w.address, w.customName ?? null, w.starred ?? 0, w.source ?? null,
      w.winRate ?? null, w.feeEarned ?? null, w.totalPools ?? null, w.ev ?? null,
      w.avgAgeHours ?? null, w.avgInvested ?? null, w.avgMonthlyProfit ?? null,
      w.tempo ?? null, w.playType ?? null, w.rangeStyle ?? null, w.session ?? null,
      w.pnlUsd ?? null, w.pnlSol ?? null,
      w.openPositions ?? null, w.openPools ?? null, w.tier ?? null,
      w.firstActivity ?? null, w.lastActivity ?? null,
    );
}

export function insertSnapshot(s: SnapshotInput) {
  getDb()
    .prepare(
      `INSERT INTO wallet_snapshots (wallet, timeframe, positions, profit)
       VALUES (?,?,?,?)
       ON CONFLICT(wallet, timeframe) DO UPDATE SET
         positions=excluded.positions, profit=excluded.profit`,
    )
    .run(s.wallet, s.timeframe, s.positions, s.profit);
}

export function listWallets(): WalletRow[] {
  return getDb()
    .prepare(`SELECT address, custom_name AS customName, starred, source,
              win_rate AS winRate, fee_earned AS feeEarned, total_pools AS totalPools,
              ev, avg_age_hours AS avgAgeHours, avg_invested AS avgInvested,
              avg_monthly_profit AS avgMonthlyProfit, tempo, play_type AS playType,
              range_style AS rangeStyle, session, pnl_usd AS pnlUsd, pnl_sol AS pnlSol,
              open_positions AS openPositions, open_pools AS openPools, tier,
              first_activity AS firstActivity,
              last_activity AS lastActivity FROM wallets`)
    .all() as unknown as WalletRow[];
}
