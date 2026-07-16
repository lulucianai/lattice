#!/usr/bin/env python3
"""
Discovery scraper for lattice — Scrapling edition.

Why Python/Scrapling here: lpagent/fabriq sit behind Cloudflare. Scrapling's
StealthySession(solve_cloudflare=True) is purpose-built to pass Turnstile/
Interstitial and is far more stable than driving Camoufox by hand (retries,
fingerprint spoofing, proxy rotation are built in).

This process ONLY discovers wallets (the Cloudflare-hard part) and writes them to
the shared SQLite DB. All on-chain enrichment (Helius/datapi range + PnL) and the
dashboard stay in the Node worker/web — the DB is the hand-off.

Run:
    pip install -r scraper/requirements.txt
    scrapling install                # fetches the stealth browser (one time)
    python scraper/discover.py --pages 30

Env:
    LATTICE_DB     path to the sqlite file (default ../data/lattice.sqlite)
    SMARTLP_PAGES  default page cap (overridden by --pages)
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

from scrapling.fetchers import StealthySession

DB_PATH = os.environ.get(
    "LATTICE_DB",
    str(Path(__file__).resolve().parent.parent / "data" / "lattice.sqlite"),
)
SMARTLP_URL = "https://app.lpagent.io/smart-lp?page={page}"


# ---- parsing (mirrors packages/ingest/src/adapters/lpagent.ts) ----------------

def _num(s):
    if s is None:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", s.replace(",", ""))
    return float(m.group()) if m else None


def parse_smartlp(page_text, addresses):
    """Segment the rendered text by the 'Win Rate' label; zip with ordered addrs."""
    lines = [ln.strip() for ln in page_text.split("\n")]
    starts = [i for i, ln in enumerate(lines) if ln == "Win Rate"]

    def after(seg, label):
        for i, ln in enumerate(seg):
            if ln.lower() == label.lower() and i + 1 < len(seg):
                return seg[i + 1]
        return None

    def tf(seg, label):
        for i, ln in enumerate(seg):
            if ln == label:
                return (_num(seg[i + 1]) if i + 1 < len(seg) else None,
                        _num(seg[i + 2]) if i + 2 < len(seg) else None)
        return (None, None)

    out, ai = [], 0
    for k, start in enumerate(starts):
        seg = [x for x in lines[start:(starts[k + 1] if k + 1 < len(starts) else len(lines))] if x]
        fa = after(seg, "First Activity")
        if not fa or not re.search(r"\d{2}/\d{2}/\d{4}", fa):
            continue  # skip the sort-control "Win Rate" false hit
        if ai >= len(addresses):
            break
        out.append({
            "address": addresses[ai],
            "winRate": _num(after(seg, "Win Rate")),
            "feeEarned": _num(after(seg, "Fee Earned")),
            "totalPools": _num(after(seg, "Total Pools")),
            "avgAgeHours": _num(after(seg, "Avg Age")),
            "avgInvested": _num(after(seg, "Avg Invested")),
            "avgMonthlyProfit": _num(after(seg, "Avg Monthly Profit")),
            "d7": tf(seg, "7D"), "d30": tf(seg, "30D"), "all": tf(seg, "ALL"),
            "firstActivity": fa,
        })
        ai += 1
    return out


# ---- classification (mirrors packages/core/src/classify.ts) -------------------

def tempo(age):
    if age is None:
        return None
    return "scalp" if age <= 1 else "intraday" if age <= 8 else "swing" if age <= 48 else "position"


def play_type(age, pools):
    if pools is None and age is None:
        return None
    if (pools or 0) >= 250:
        return "multi"
    if (age or 99) <= 2:
        return "fast"
    return "multi" if (pools or 0) >= 120 else "fast"


# ---- DB -----------------------------------------------------------------------

def upsert(conn, w):
    now = int(time.time() * 1000)
    fa = None
    try:
        import datetime
        fa = int(datetime.datetime.strptime(w["firstActivity"], "%m/%d/%Y").timestamp() * 1000)
    except Exception:
        pass
    conn.execute(
        """INSERT INTO wallets (address, source, win_rate, fee_earned, total_pools,
             avg_age_hours, avg_invested, avg_monthly_profit, tempo, play_type,
             first_activity, last_activity)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(address) DO UPDATE SET
             source=excluded.source, win_rate=excluded.win_rate, fee_earned=excluded.fee_earned,
             total_pools=excluded.total_pools, avg_age_hours=excluded.avg_age_hours,
             avg_invested=excluded.avg_invested, avg_monthly_profit=excluded.avg_monthly_profit,
             tempo=excluded.tempo, play_type=excluded.play_type,
             last_activity=excluded.last_activity, updated_at=?""",
        (w["address"], "lpagent", w["winRate"], w["feeEarned"], w["totalPools"],
         w["avgAgeHours"], w["avgInvested"], w["avgMonthlyProfit"],
         tempo(w["avgAgeHours"]), play_type(w["avgAgeHours"], w["totalPools"]),
         fa, now, now),
    )
    for tflabel, pair in (("7d", w["d7"]), ("30d", w["d30"]), ("all", w["all"])):
        conn.execute(
            """INSERT INTO wallet_snapshots (wallet, timeframe, positions, profit)
               VALUES (?,?,?,?)
               ON CONFLICT(wallet, timeframe) DO UPDATE SET
                 positions=excluded.positions, profit=excluded.profit""",
            (w["address"], tflabel, pair[0] or 0, pair[1] or 0),
        )
    # time-series point so 12h/24h deltas accumulate across runs
    conn.execute(
        "INSERT INTO wallet_history (wallet, captured_at, profit_all, fee_earned, positions_all) VALUES (?,?,?,?,?)",
        (w["address"], now, w["all"][1], w["feeEarned"], w["all"][0]),
    )


# ---- extraction via Scrapling's selector API (no in-page JS needed) ----------

def extract(resp):
    """Pull ordered wallet addresses + rendered text from a fetched page.
    Method names differ slightly across Scrapling versions; we try the common ones."""
    # addresses from the /portfolio?address= links, in DOM order, de-duped
    addrs, seen = [], set()
    for href in resp.css('a[href*="/portfolio?address="]::attr(href)'):
        x = str(href).split("address=")[1].split("&")[0]
        if x and x not in seen:
            seen.add(x)
            addrs.append(x)
    # rendered text of the page
    try:
        page_text = resp.get_all_text(separator="\n")
    except Exception:
        page_text = resp.css("body::text") if hasattr(resp, "css") else str(resp)
        if isinstance(page_text, (list, tuple)):
            page_text = "\n".join(str(t) for t in page_text)
    return page_text, addrs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, default=int(os.environ.get("SMARTLP_PAGES", 30)))
    ap.add_argument("--delay", type=float, default=2.5, help="seconds between pages (be polite)")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")  # coexist with the Node worker's writes
    total = 0
    with StealthySession(headless=True, solve_cloudflare=True) as session:
        for page in range(1, args.pages + 1):
            url = SMARTLP_URL.format(page=page)
            resp = session.fetch(url, network_idle=True)
            page_text, addresses = extract(resp)
            rows = parse_smartlp(page_text, addresses)
            if not rows:
                print(f"[page {page}] empty — stopping", flush=True)
                break
            for w in rows:
                upsert(conn, w)
            conn.commit()
            total += len(rows)
            print(f"[page {page}] +{len(rows)} wallets (total {total})", flush=True)
            time.sleep(args.delay)
    conn.close()
    print(f"Done. Discovered/updated {total} wallets.", flush=True)


if __name__ == "__main__":
    sys.exit(main())
