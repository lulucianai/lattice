// Camoufox scraping driver (runs 24/7 on the VPS).
//
// Camoufox is an anti-detect Firefox that speaks the Playwright API, which is how
// it slips past lpagent's Cloudflare where plain fetch gets a 403. We drive it with
// the standard Playwright Page API, so the extraction logic is identical whether
// the browser is Camoufox or vanilla Playwright-Firefox (for local testing).
//
// Server setup:
//   npm i camoufox-js playwright
//   npx camoufox-js fetch          # downloads the patched Firefox
// Then run the worker with a real display or headless=true.
//
// Politeness: navigate, wait for content, extract, then a randomized delay. Keep
// concurrency at 1 and the page interval at minutes, not seconds (see worker).

import { setTimeout as sleep } from "node:timers/promises";
import type {
  ScrapeBrowser,
  PoolCardCapture,
  SmartLpCapture,
} from "./lpagent.js";

// Minimal structural types so this file type-checks without playwright installed.
interface Page {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: string | ((...a: unknown[]) => T)): Promise<T>;
}
interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

/** Launch Camoufox (preferred) or fall back to Playwright Firefox for local dev. */
export async function launchBrowser(headless = true): Promise<Browser> {
  // camoufox-js / playwright are OPTIONAL server-only deps (install on the VPS if
  // you use this fallback instead of the Python/Scrapling scraper), so they're
  // resolved dynamically and not type-checked here.
  const load = (m: string) => import(/* @vite-ignore */ m) as Promise<unknown>;
  try {
    const { Camoufox } = (await load("camoufox-js")) as {
      Camoufox: (o: { headless?: boolean; humanize?: boolean }) => Promise<Browser>;
    };
    return await Camoufox({ headless, humanize: true });
  } catch {
    const { firefox } = (await load("playwright")) as {
      firefox: { launch: (o: { headless?: boolean }) => Promise<Browser> };
    };
    return await firefox.launch({ headless });
  }
}

// --- extraction scripts (run in page context; mirror the verified logic) --------

const POOL_CARDS_JS = `(() => {
  const cards = Array.from(document.querySelectorAll('a[href*="/pools/"]'))
    .filter(a => /\\/pools\\/[1-9A-HJ-NP-Za-km-z]{25,}/.test(a.getAttribute('href')||''))
    .map(a => a.closest('a'));
  const seen = new Set(); const out = [];
  for (const a of cards) {
    if (!a) continue;
    const addr = a.getAttribute('href').split('/pools/')[1].split('?')[0];
    if (seen.has(addr)) continue; seen.add(addr);
    out.push({ address: addr, text: a.innerText });
  }
  return out;
})()`;

const SMARTLP_JS = `(() => {
  const addrs = []; const seen = new Set();
  document.querySelectorAll('a[href*="/portfolio?address="]').forEach(a => {
    const x = (a.getAttribute('href').split('address=')[1]||'').split('&')[0];
    if (x && !seen.has(x)) { seen.add(x); addrs.push(x); }
  });
  return { pageText: document.body.innerText, addresses: addrs };
})()`;

export class CamoufoxBrowser implements ScrapeBrowser {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {}

  static async create(headless = true): Promise<CamoufoxBrowser> {
    const browser = await launchBrowser(headless);
    const page = await browser.newPage();
    return new CamoufoxBrowser(browser, page);
  }

  private async load(url: string, waitFor: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    try {
      await this.page.waitForSelector(waitFor, { timeout: 20_000 });
    } catch {
      /* content may already be present or the page shape changed */
    }
    await sleep(800 + Math.random() * 700); // let RSC hydration settle + look human
  }

  async poolCards(url: string): Promise<PoolCardCapture[]> {
    await this.load(url, 'a[href*="/pools/"]');
    return this.page.evaluate<PoolCardCapture[]>(POOL_CARDS_JS);
  }

  async smartLpPage(url: string): Promise<SmartLpCapture> {
    await this.load(url, 'a[href*="/portfolio?address="]');
    return this.page.evaluate<SmartLpCapture>(SMARTLP_JS);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
