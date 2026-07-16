import { getLeaderboard, getOverview, type Timeframe, type WalletRow } from "@/lib/db";
import { getSolPrice } from "@/lib/price";
import { StarToggle, NameEditor } from "./WalletControls";

export const dynamic = "force-dynamic";

const TF: Timeframe[] = ["12h", "24h", "7d", "30d", "all"];
type Cur = "usd" | "sol";

// money(): all stored values are SOL; render in the chosen currency.
function makeMoney(cur: Cur, solUsd: number) {
  return (valSol: number, d = 2) => {
    if (cur === "usd") {
      const v = valSol * solUsd;
      const dd = Math.abs(v) >= 1000 ? 0 : d;
      return `$${v.toLocaleString("en-US", { minimumFractionDigits: dd, maximumFractionDigits: dd })}`;
    }
    return `◎${valSol.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  };
}
const num = (n: number) => n.toLocaleString("en-US");
const pctv = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);

function shortAddr(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}
function relTime(ms: number | null) {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function ageLabel(h: number | null) {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// proper display names for session badges (NY stays NY, not "Ny")
const SESSION_LABEL: Record<string, string> = {
  ny: "NY", london: "London", asia: "Asia", mixed: "Mixed",
};

type SortKey =
  | "profit" | "pnlpct" | "live" | "fees" | "pools" | "age" | "inv" | "win" | "pos";
const SORT_ACCESSOR: Record<SortKey, (r: WalletRow, cur: Cur) => number> = {
  profit: (r) => r.profit,
  pnlpct: (r) => (r.avgInvested && r.avgInvested > 0 ? r.profit / r.avgInvested : -Infinity),
  live: (r, cur) => (cur === "usd" ? r.pnlUsd : r.pnlSol) ?? -Infinity,
  fees: (r) => r.feeEarned ?? -Infinity,
  pools: (r) => r.totalPools ?? -Infinity,
  age: (r) => r.avgAgeHours ?? -Infinity,
  inv: (r) => r.avgInvested ?? -Infinity,
  win: (r) => r.winRate ?? -Infinity,
  pos: (r) => r.positions,
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ tf?: string; cur?: string; sort?: string; dir?: string }>;
}) {
  const sp = await searchParams;
  // default to 7d (lpagent gives real 7d/30d/all). 12h/24h are our snapshot deltas —
  // they only have values once the worker has run ≥ that long, so not the default.
  const timeframe: Timeframe = TF.includes(sp.tf as Timeframe) ? (sp.tf as Timeframe) : "7d";
  const cur: Cur = sp.cur === "sol" ? "sol" : "usd";
  const sort = (sp.sort && sp.sort in SORT_ACCESSOR ? sp.sort : "profit") as SortKey;
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const { usd: solUsd, live } = await getSolPrice();
  const money = makeMoney(cur, solUsd);

  const rows = getLeaderboard(timeframe);
  const ov = getOverview(timeframe);
  const empty = rows.length === 0;
  // sort by the chosen column/direction (default: timeframe profit, desc)
  const acc = SORT_ACCESSOR[sort];
  rows.sort((a, b) => (dir === "asc" ? acc(a, cur) - acc(b, cur) : acc(b, cur) - acc(a, cur)));

  const q = (over: Partial<{ tf: Timeframe; cur: Cur; sort: SortKey; dir: string }>) =>
    `/?tf=${over.tf ?? timeframe}&cur=${over.cur ?? cur}&sort=${over.sort ?? sort}&dir=${over.dir ?? dir}`;
  // header link: clicking the active column flips direction, otherwise desc
  const sortHref = (key: SortKey) =>
    q({ sort: key, dir: sort === key && dir === "desc" ? "asc" : "desc" });
  const caret = (key: SortKey) => (sort === key ? (dir === "desc" ? " ▼" : " ▲") : "");

  return (
    <div className="wrap">
      <div className="grid-hero">
        <div className="hero">
          <p className="eyebrow">Tracked Wallet Intelligence</p>
          <h1>A cleaner view of who adds liquidity, who stays green, and where capital concentrates.</h1>
          <p className="lead">
            Top on-chain liquidity providers — ranked by PnL, classified by hold tempo,
            play type, and range. Click any wallet to open it on the explorer.
          </p>
          <div className="controls">
            <div className="tf-group">
              {TF.map((t) => (
                <a key={t} href={q({ tf: t })} className={`tf${t === timeframe ? " active" : ""}`}>{t}</a>
              ))}
            </div>
            <div className="tf-group">
              <a href={q({ cur: "usd" })} className={`tf${cur === "usd" ? " active" : ""}`}>USD</a>
              <a href={q({ cur: "sol" })} className={`tf${cur === "sol" ? " active" : ""}`}>SOL</a>
            </div>
          </div>
          <p className="price-note">
            SOL ${solUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}
            <span className={live ? "dot live" : "dot"} /> {live ? "live · CoinGecko" : "fallback price"}
          </p>
        </div>
        <div className="hero-side">
          <div className="card">
            <div className="label">Overview</div>
            <div className="value xl">{num(ov.discovered)}</div>
            <div className="sub">{num(ov.totalWallets)} enriched · {ov.activeToday} active today</div>
          </div>
          <div className="card">
            <div className="label">{timeframe} PnL snapshot</div>
            <div className={`value xl ${ov.totalProfit >= 0 ? "green" : "red"}`}>{money(ov.totalProfit, 0)}</div>
            <div className="sub">{money(ov.totalFee, 0)} fees across {ov.greenWallets} green wallets</div>
          </div>
        </div>
      </div>

      <div className="cards">
        <Stat label={`${timeframe} · tracked`} value={num(ov.totalWallets)} sub={`${ov.greenWallets} green`} />
        <Stat label="total fees earned" value={money(ov.totalFee, 0)} sub="all wallets" green />
        <Stat label="cohorts" value={`${ov.green7d} / ${ov.green30d}`} sub="green 7d / 30d" />
        <Stat label="avg invested" value={money(ov.avgInvested)} sub="per wallet" />
      </div>
      <div className="cards">
        <Stat label="green 7d" value={num(ov.green7d)} sub="green last 7d" green />
        <Stat label="avg monthly profit" value={money(ov.avgMonthlyProfit, 0)} sub="summed" green />
        <Stat label={`${timeframe} positions`} value={num(ov.totalPositions)} sub="opened in window" />
        <Stat label="data source" value="lpagent · datapi" sub="hybrid, cross-checked" small />
      </div>

      {empty ? (
        <div className="card"><div className="label">no data</div><div className="sub">Run <code>npm run db:seed</code>.</div></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="left">#</th>
                <th className="left">wallet</th>
                <th className="left">style</th>
                <th><a className="sort" href={sortHref("profit")}>{timeframe} pnl{caret("profit")}</a></th>
                <th><a className="sort" href={sortHref("pnlpct")}>pnl %{caret("pnlpct")}</a></th>
                <th><a className="sort" href={sortHref("live")}>onchain pnl{caret("live")}</a></th>
                <th><a className="sort" href={sortHref("fees")}>fees{caret("fees")}</a></th>
                <th><a className="sort" href={sortHref("pools")}>pools{caret("pools")}</a></th>
                <th><a className="sort" href={sortHref("age")}>avg age{caret("age")}</a></th>
                <th><a className="sort" href={sortHref("inv")}>avg inv.{caret("inv")}</a></th>
                <th><a className="sort" href={sortHref("win")}>win{caret("win")}</a></th>
                <th>coh</th>
                <th><a className="sort" href={sortHref("pos")}>pos.{caret("pos")}</a></th>
                <th>last</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => <Row key={r.address} r={r} rank={i + 1} money={money} cur={cur} solUsd={solUsd} />)}
            </tbody>
          </table>
        </div>
      )}
      <p className="foot">
        Showing {rows.length} enriched of {num(ov.discovered)} discovered wallets · the rest are
        real wallets found on-chain, pending enrichment (fills as the 24/7 worker runs).
        All values are derived from on-chain data — no dummy values.
      </p>
    </div>
  );
}

function Stat({ label, value, sub, green, small }: { label: string; value: string; sub: string; green?: boolean; small?: boolean }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={`value${green ? " green" : ""}${small ? " sm" : ""}`}>{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

const winClass = (w: number | null) => (w == null ? "" : w >= 88 ? "win-elite" : w >= 83 ? "win-strong" : "win-ok");

function Row({
  r, rank, money, cur,
}: {
  r: WalletRow; rank: number; money: (v: number, d?: number) => string; cur: Cur; solUsd: number;
}) {
  const pnlPct = r.avgInvested && r.avgInvested > 0 ? (r.profit / r.avgInvested) * 100 : null;
  const live = cur === "usd" ? r.pnlUsd : r.pnlSol;
  const liveStr =
    live == null ? "—" : cur === "usd"
      ? `$${live.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : `◎${live.toFixed(2)}`;
  const dot = (v: number | null) => (v == null ? "·" : v > 0 ? "●" : "○");
  return (
    <tr>
      <td className="left rank"><StarToggle address={r.address} starred={!!r.starred} /> {rank}</td>
      <td className="left">
        <a className="addr" href={`https://solscan.io/account/${r.address}`} target="_blank" rel="noopener noreferrer">{shortAddr(r.address)}</a>
        {r.customName ? <span className="name">{r.customName}</span> : null}
        <NameEditor address={r.address} name={r.customName} />
      </td>
      <td className="left">
        {r.rangeStyle ? <span className="badge range">{r.rangeStyle.replace("_", " ")}</span> : null}
        {r.tempo ? <span className="badge tempo">{r.tempo}</span> : null}
        {r.playType ? <span className="badge play">{r.playType}</span> : null}
        {r.session ? <span className="badge session">{SESSION_LABEL[r.session] ?? r.session}</span> : null}
      </td>
      <td className={r.profit >= 0 ? "pos" : "neg"}>{money(r.profit)}</td>
      <td className={pnlPct == null ? "" : pnlPct >= 0 ? "pos" : "neg"}>
        {pnlPct == null ? "—" : `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`}
      </td>
      <td className={live == null ? "" : live >= 0 ? "pos" : "neg"}>{liveStr}</td>
      <td>{r.feeEarned == null ? "—" : money(r.feeEarned)}</td>
      <td>{r.totalPools == null ? "—" : num(r.totalPools)}</td>
      <td>{ageLabel(r.avgAgeHours)}</td>
      <td>{r.avgInvested == null ? "—" : money(r.avgInvested)}</td>
      <td className={winClass(r.winRate)}>{pctv(r.winRate)}</td>
      <td className="coh">{dot(r.profit7d)}{dot(r.profit30d)}</td>
      <td>{num(r.positions)}</td>
      <td className="rank">{relTime(r.lastActivity)}</td>
    </tr>
  );
}
