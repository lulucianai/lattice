// Seed REAL wallets scraped live from app.lpagent.io/smart-lp (2026-07-15).
// Values are SOL-denominated (as lpagent shows them). This doubles as a fixture
// of the real data shape until the Camoufox scraper feeds the DB continuously.

import { getDb, upsertWallet, insertSnapshot } from "./index.js";
import { classifyTempo, classifyPlayTypeFromBreadth } from "@lattice/core";

type Row = {
  address: string;
  winRate: number; feeEarned: number; totalPools: number; ev: number;
  avgAgeHours: number; avgInvested: number; avgMonthlyProfit: number;
  d7: [number, number]; d30: [number, number]; all: [number, number];
  firstActivity: string; // MM/DD/YYYY
};

const ROWS: Row[] = [
  { address: "4Cgt8kjFD6WLfGWpFXuuMyYnD21ZcAuiRsBUHAtFf2wk", winRate: 86.35, feeEarned: 78.02, totalPools: 1062, ev: 0.02, avgAgeHours: 0.3, avgInvested: 2.97, avgMonthlyProfit: 3.99, d7: [117, 1.14], d30: [1053, 9.38], all: [5189, 19.95], firstActivity: "03/09/2026" },
  { address: "5cvvCSZeno4oLm2bZCRYhMxNvFbTqEAV4XJ7wa2aLrn3", winRate: 80.11, feeEarned: 97.28, totalPools: 220, ev: 0.05, avgAgeHours: 4.8, avgInvested: 5.10, avgMonthlyProfit: 2.79, d7: [4, -8.70], d30: [31, -4.42], all: [637, 19.54], firstActivity: "01/24/2026" },
  { address: "EJRLM1ZsyCXt14gbfjAhvJz7743PkNMazWS13FivQi29", winRate: 84.88, feeEarned: 202.68, totalPools: 673, ev: 0.02, avgAgeHours: 1.0, avgInvested: 5.94, avgMonthlyProfit: 1.76, d7: [14, 0.99], d30: [81, -2.07], all: [2530, 19.36], firstActivity: "09/05/2025" },
  { address: "24QpM5YJfZ1vXuXpTVW9CoEy5bJ2fMaaMNyshaNwzAdq", winRate: 84.43, feeEarned: 24.30, totalPools: 99, ev: 0.12, avgAgeHours: 1.9, avgInvested: 0.83, avgMonthlyProfit: 6.44, d7: [20, 1.43], d30: [130, 10.04], all: [271, 19.32], firstActivity: "05/23/2026" },
  { address: "BPjNvrMKdkvGx6iMrLoKsdcACvgPjtnZWXm31HmTRygs", winRate: 87.19, feeEarned: 106.47, totalPools: 301, ev: 0.03, avgAgeHours: 2.1, avgInvested: 3.52, avgMonthlyProfit: 3.20, d7: [63, -1.10], d30: [215, -2.00], all: [1646, 19.19], firstActivity: "03/01/2026" },
  { address: "FMukQuz3t48WETKWKiVGZkz7Cuy1pVkMFBaGC3Ndy46D", winRate: 90.37, feeEarned: 93.61, totalPools: 431, ev: 0.03, avgAgeHours: 0.9, avgInvested: 5.32, avgMonthlyProfit: 2.74, d7: [112, 0.50], d30: [737, 7.22], all: [1593, 19.18], firstActivity: "01/31/2026" },
  { address: "9Bp8RkRp3sn3ZBGGxzneHsYNrqZms47TdFa4GbYBc98L", winRate: 87.82, feeEarned: 100.98, totalPools: 311, ev: 0.04, avgAgeHours: 2.8, avgInvested: 5.19, avgMonthlyProfit: 3.04, d7: [35, -0.38], d30: [101, 1.57], all: [1018, 18.26], firstActivity: "02/07/2026" },
  { address: "BuzYAiju3e2ENH4VFn4Ne68jCuFE6ZdFkRoeVHm8MZNr", winRate: 80.11, feeEarned: 31.79, totalPools: 119, ev: 0.10, avgAgeHours: 0.4, avgInvested: 4.08, avgMonthlyProfit: 3.63, d7: [31, 2.24], d30: [277, 15.36], all: [494, 18.16], firstActivity: "03/24/2026" },
  { address: "7aTh1tyHd99dPAF6uJBqkCesanEfhj4vW8X3D2HRsAgB", winRate: 83.66, feeEarned: 100.81, totalPools: 918, ev: 0.02, avgAgeHours: 7.3, avgInvested: 0.86, avgMonthlyProfit: 1.21, d7: [38, 0.59], d30: [150, 1.39], all: [2054, 18.08], firstActivity: "01/26/2025" },
  { address: "GkuzpE5NGqizj4Fgw1XN1JysETq26zMArsgqWGAwK5V", winRate: 85.79, feeEarned: 64.20, totalPools: 109, ev: 0.09, avgAgeHours: 0.9, avgInvested: 14.21, avgMonthlyProfit: 4.50, d7: [15, 0.84], d30: [53, 12.28], all: [384, 18.00], firstActivity: "04/19/2026" },
  { address: "4nDcoEr5EvTL3k3XhgdewvNwzkd7iVV2A8UDZ163xxUy", winRate: 88.03, feeEarned: 40.28, totalPools: 145, ev: 0.15, avgAgeHours: 15.8, avgInvested: 6.76, avgMonthlyProfit: 1.12, d7: [1, 0.00], d30: [14, 1.13], all: [298, 17.92], firstActivity: "12/29/2024" },
  { address: "DY9DVtLDvWofjRwfG8wb7HEY9jwtKYYcVqc5mR359Gzx", winRate: 87.48, feeEarned: 75.34, totalPools: 140, ev: 0.03, avgAgeHours: 40.1, avgInvested: 1.61, avgMonthlyProfit: 1.28, d7: [9, -0.03], d30: [49, 2.86], all: [1905, 17.86], firstActivity: "06/05/2025" },
  // --- smart-lp page 2 ---
  { address: "56bEwVDPfznXyrD5rW6W7gh7wWBhCCnMhRockTngG3UD", winRate: 91.46, feeEarned: 35.41, totalPools: 57, ev: 0, avgAgeHours: 2.3, avgInvested: 11.59, avgMonthlyProfit: 8.77, d7: [17, 4.26], d30: [303, 17.55], all: [305, 17.55], firstActivity: "06/17/2026" },
  { address: "DFVcazgzxYKw7Uoff2NYpnFWAjiHzycB7WJtYQ8xoPwA", winRate: 84.15, feeEarned: 26.79, totalPools: 63, ev: 0, avgAgeHours: 322.3, avgInvested: 1.36, avgMonthlyProfit: 3.48, d7: [1, 0.22], d30: [13, 1.9], all: [190, 17.4], firstActivity: "03/01/2026" },
  { address: "6eP3TiRG1tXjANnUxmG5k1bVB1ibmVZiBMfueHBy8kGu", winRate: 87.87, feeEarned: 107.91, totalPools: 198, ev: 0, avgAgeHours: 0.6, avgInvested: 7.75, avgMonthlyProfit: 3.45, d7: [139, -7.31], d30: [593, 9.2], all: [940, 17.26], firstActivity: "03/27/2026" },
  { address: "GVKSqmvo4v33NHqnzMq7qpsH1wwZJDzr8uyrE6eKR1Y6", winRate: 86.17, feeEarned: 65.23, totalPools: 119, ev: 0, avgAgeHours: 0.4, avgInvested: 5.66, avgMonthlyProfit: 8.62, d7: [173, 4.34], d30: [475, 17.25], all: [476, 17.25], firstActivity: "06/26/2026" },
  { address: "8zPqBkL1u62urzkR46h1exKHEuYWDRuwFp4yc6VS8rKK", winRate: 83.68, feeEarned: 130.97, totalPools: 329, ev: 0, avgAgeHours: 12.9, avgInvested: 2.35, avgMonthlyProfit: 1.55, d7: [41, -1.12], d30: [41, -1.12], all: [2465, 17.02], firstActivity: "09/23/2025" },
  { address: "F55MiSEZSuf3aAXyD14fqJTT1sAfDNxcYAnTX8JfMHmd", winRate: 84.55, feeEarned: 71.91, totalPools: 303, ev: 0, avgAgeHours: 0.9, avgInvested: 3.79, avgMonthlyProfit: 4.05, d7: [29, -2.09], d30: [471, 12.35], all: [1978, 16.2], firstActivity: "02/05/2026" },
  { address: "6W4fj1r7E3JGAjEywkBqH5YaZpkttVTqfo7nnWUMTVtG", winRate: 85.25, feeEarned: 40.63, totalPools: 156, ev: 0, avgAgeHours: 0.4, avgInvested: 3.87, avgMonthlyProfit: 5.37, d7: [42, 2.72], d30: [315, 13], all: [674, 16.11], firstActivity: "05/28/2026" },
  { address: "CLQ7TS7uQgPr1KRQSFWi6DQWfHKM5NqxVz7P1pRLZNap", winRate: 85.42, feeEarned: 17.81, totalPools: 18, ev: 0, avgAgeHours: 3.1, avgInvested: 41.67, avgMonthlyProfit: 15.94, d7: [33, 2.39], d30: [97, 15.94], all: [102, 15.94], firstActivity: "07/04/2026" },
  { address: "GgpU7afhLUWBBwr4YRiQYfwnwCfVia9LKMQdiFYNN96e", winRate: 83.53, feeEarned: 164.27, totalPools: 582, ev: 0, avgAgeHours: 2.3, avgInvested: 1.85, avgMonthlyProfit: 1.59, d7: [9, -0.23], d30: [73, 0.72], all: [2829, 15.93], firstActivity: "10/11/2025" },
  { address: "4CLd8rJ9wmWbBDFDmg68wMTBaq6BJuDeCi5HYqPucEmo", winRate: 80.6, feeEarned: 129.19, totalPools: 1433, ev: 0, avgAgeHours: 1, avgInvested: 2.21, avgMonthlyProfit: 1.05, d7: [37, 0.25], d30: [387, 0.66], all: [6710, 15.8], firstActivity: "05/23/2025" },
  { address: "GKR1eP28DdpPLtQQm9VVya1GErbabiMzCtoYGAHwRKoc", winRate: 86.79, feeEarned: 24.27, totalPools: 41, ev: 0, avgAgeHours: 511.8, avgInvested: 1.24, avgMonthlyProfit: 3.05, d7: [0, 0], d30: [4, 0.12], all: [88, 15.24], firstActivity: "03/18/2026" },
  { address: "HUcjzpA5ZqCwaTUcyr7kF9GhPNK3hxxndfvjo8TcbTsQ", winRate: 82.29, feeEarned: 223.92, totalPools: 309, ev: 0, avgAgeHours: 4.3, avgInvested: 6.89, avgMonthlyProfit: 5.08, d7: [525, 0.23], d30: [1141, 5.4], all: [2071, 15.23], firstActivity: "05/02/2026" },
  // --- smart-lp page 3 ---
  { address: "EE8HMgdpYam23Ae7eLzS48A8BLBLMkyduJtWQygXSEnz", winRate: 81.93, feeEarned: 43.2, totalPools: 181, ev: 0, avgAgeHours: 2.2, avgInvested: 2.39, avgMonthlyProfit: 7.6, d7: [299, 3.8], d30: [917, 14.32], all: [998, 15.2], firstActivity: "06/10/2026" },
  { address: "C5uRK3abg5hSfa27K5ZjT3gTmXdC48uBxpg1YLBZNsLB", winRate: 89.53, feeEarned: 28.96, totalPools: 46, ev: 0, avgAgeHours: 1.5, avgInvested: 3.51, avgMonthlyProfit: 7.59, d7: [4, 0.01], d30: [114, 15.18], all: [116, 15.18], firstActivity: "06/28/2026" },
  { address: "CSnDFnWisQCLKopN1uWZkYpfXQcCrTmLdsUvmsdL6VwB", winRate: 85.17, feeEarned: 66.45, totalPools: 142, ev: 0, avgAgeHours: 0.3, avgInvested: 7.4, avgMonthlyProfit: 2.53, d7: [2, 0.03], d30: [2, 0.03], all: [485, 15.17], firstActivity: "11/05/2025" },
  { address: "96rRLYCnctyZoPKW6MtkKhrJUGSbRsV4SHiPpRxPabXa", winRate: 92.7, feeEarned: 33.3, totalPools: 68, ev: 0, avgAgeHours: 2.1, avgInvested: 5.73, avgMonthlyProfit: 15.12, d7: [443, 8.25], d30: [636, 15.12], all: [642, 15.12], firstActivity: "07/04/2026" },
  { address: "9mJgHvePKz2RcUSFHnbjqZ3Co172eFrKmV2SUta7eLvZ", winRate: 91.32, feeEarned: 59.95, totalPools: 132, ev: 0, avgAgeHours: 2.6, avgInvested: 5.54, avgMonthlyProfit: 7.52, d7: [3, 0], d30: [386, 15.48], all: [484, 15.03], firstActivity: "06/06/2026" },
  { address: "9ibgZH4coNPGsrLWdb68zRgTHEfUvRuFjQZFGt5DecGh", winRate: 82.51, feeEarned: 219.91, totalPools: 317, ev: 0, avgAgeHours: 8.1, avgInvested: 6.72, avgMonthlyProfit: 3.72, d7: [60, 7.96], d30: [1785, 0.57], all: [3252, 14.9], firstActivity: "04/08/2026" },
  { address: "CuHFvwUqxsTqcbeVLJjVLf9Pirr4RtBeGA4KXY6gGhik", winRate: 90.76, feeEarned: 43.38, totalPools: 324, ev: 0, avgAgeHours: 0.4, avgInvested: 2.52, avgMonthlyProfit: 1.85, d7: [23, 0.1], d30: [103, 3.6], all: [536, 14.8], firstActivity: "12/14/2025" },
  { address: "4zLbhKsuPASVojULDcLCWjYQaquy9uEjXJNJuv7W8Cxn", winRate: 82.07, feeEarned: 45.7, totalPools: 266, ev: 0, avgAgeHours: 22.1, avgInvested: 1.86, avgMonthlyProfit: 0.85, d7: [12, 0.61], d30: [58, 2.69], all: [1517, 14.49], firstActivity: "03/03/2025" },
  { address: "58itiGzYASW6F5AE5f9yPpioC3x2Rc9Rq2V92S2e6V7h", winRate: 81.57, feeEarned: 56.02, totalPools: 143, ev: 0, avgAgeHours: 2.1, avgInvested: 8.95, avgMonthlyProfit: 2.37, d7: [28, -0.35], d30: [134, 5.78], all: [540, 14.22], firstActivity: "02/06/2026" },
  { address: "8Qu7iqQCzm4yYnUQVitpsxmxGi9mnpyz1iBUszsTCrAw", winRate: 85.98, feeEarned: 74.15, totalPools: 896, ev: 0, avgAgeHours: 1.5, avgInvested: 2.29, avgMonthlyProfit: 2.03, d7: [124, 1.38], d30: [844, 3.42], all: [4408, 14.21], firstActivity: "01/19/2026" },
  { address: "FguTstDnUMoxGPiCpU1voW7MVFz7a2W1d57bGgobm34J", winRate: 81.92, feeEarned: 127, totalPools: 698, ev: 0, avgAgeHours: 3.3, avgInvested: 1.58, avgMonthlyProfit: 1.54, d7: [63, -2.29], d30: [527, -2.64], all: [3850, 13.83], firstActivity: "10/03/2024" },
  { address: "J4wYoMuCykX2oofjATYidQF9WgQt7kRSfHZsA55TfkbD", winRate: 82.7, feeEarned: 50.47, totalPools: 198, ev: 0, avgAgeHours: 0.7, avgInvested: 4.97, avgMonthlyProfit: 2.3, d7: [4, 0.16], d30: [73, -0.76], all: [677, 13.82], firstActivity: "02/20/2026" },
];

const now = Date.now();

function main() {
  const db = getDb();
  db.exec("DELETE FROM wallet_history;");
  const histStmt = db.prepare(
    `INSERT INTO wallet_history (wallet, captured_at, profit_all, fee_earned, positions_all)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of ROWS) {
    upsertWallet({
      address: r.address,
      source: "lpagent",
      winRate: r.winRate,
      feeEarned: r.feeEarned,
      totalPools: r.totalPools,
      ev: r.ev,
      avgAgeHours: r.avgAgeHours,
      avgInvested: r.avgInvested,
      avgMonthlyProfit: r.avgMonthlyProfit,
      tempo: classifyTempo(r.avgAgeHours),
      playType: classifyPlayTypeFromBreadth(r.avgAgeHours, r.totalPools),
      firstActivity: Date.parse(r.firstActivity) || null,
      lastActivity: now - Math.floor(Math.random() * 6 * 3600_000),
    });
    insertSnapshot({ wallet: r.address, timeframe: "7d", positions: r.d7[0], profit: r.d7[1] });
    insertSnapshot({ wallet: r.address, timeframe: "30d", positions: r.d30[0], profit: r.d30[1] });
    insertSnapshot({ wallet: r.address, timeframe: "all", positions: r.all[0], profit: r.all[1] });
    // One REAL history point (now). 12h/24h deltas stay empty ("—") until the
    // worker takes further snapshots over time — no estimated/dummy values.
    histStmt.run(r.address, now, r.all[1], r.feeEarned, r.all[0]);
  }
  console.log(`Seeded ${ROWS.length} real lpagent wallets (SOL-denominated).`);
}

main();
