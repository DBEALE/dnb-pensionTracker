#!/usr/bin/env node
/**
 * Fetches proxy prices for every symbol in config/funds.json and appends
 * today's close to data/prices.json.
 *
 * Providers are tried in order until one returns a price:
 *   1. Yahoo  - rich data, but rate-limits datacenter IPs (429 from CI runners).
 *   2. Stooq  - plain CSV, no auth, works fine from CI. LSE symbols as <sym>.uk
 *   3. isin   - Aviva/Phoenix insured funds. Not implemented, see fetchIsin().
 *
 * Usage:
 *   node scripts/fetch-prices.mjs              fetch and write
 *   node scripts/fetch-prices.mjs --dry-run    fetch and report, write nothing
 *   node scripts/fetch-prices.mjs --only VAPX.L,VERX.L
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const CONFIG = "config/funds.json";
const STORE = "data/prices.json";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ONLY = (() => {
  const i = args.indexOf("--only");
  return i >= 0 && args[i + 1] ? new Set(args[i + 1].split(",")) : null;
})();

const today = () => new Date().toISOString().slice(0, 10);

function collectSymbols(config) {
  const out = new Map();
  for (const pot of config.pots)
    for (const fund of pot.funds ?? [])
      for (const c of fund.proxy?.components ?? [])
        if (c.symbol) out.set(c.symbol, fund.proxy?.type ?? "market");
  return out;
}

/* ---------- providers ---------- */

async function fetchYahoo(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=5d&interval=1d`;
  const res = await fetch(url, {
    headers: {
      // Yahoo 404s or 429s requests without a browser-ish UA.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (res.status === 429) throw new Error("HTTP 429 (rate limited - likely datacenter IP)");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const result = (await res.json())?.chart?.result?.[0];
  if (!result) throw new Error("no chart result");

  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const stamps = result.timestamp ?? [];
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null)
      return {
        price: closes[i],
        currency: result.meta?.currency ?? null,
        asOf: new Date(stamps[i] * 1000).toISOString().slice(0, 10),
        via: "yahoo",
      };
  }
  throw new Error("no non-null close in window");
}

/** Yahoo "VAPX.L" -> Stooq "vapx.uk". Stooq quotes LSE in GBX like Yahoo does. */
const toStooq = (symbol) => symbol.replace(/\.L$/i, ".uk").toLowerCase();

async function fetchStooq(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(toStooq(symbol))}&i=d`;
  const res = await fetch(url, { headers: { "User-Agent": "pension-tracker" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  const lines = text.trim().split("\n");
  // Stooq returns the literal string "No data" for unknown symbols.
  if (lines.length < 2 || /no data/i.test(text)) throw new Error("no data for symbol");

  const cols = lines[0].split(",").map((c) => c.trim().toLowerCase());
  const iDate = cols.indexOf("date");
  const iClose = cols.indexOf("close");
  if (iDate < 0 || iClose < 0) throw new Error("unexpected CSV header");

  for (let i = lines.length - 1; i >= 1; i--) {
    const row = lines[i].split(",");
    const price = parseFloat(row[iClose]);
    if (Number.isFinite(price))
      return { price, currency: null, asOf: row[iDate], via: "stooq" };
  }
  throw new Error("no parseable close");
}

/**
 * Aviva / Phoenix insured funds by ISIN. Not implemented - the Aviva Fund
 * Centre sits behind an undocumented API. See README "Wiring up Aviva prices".
 */
async function fetchIsin(isin) {
  throw new Error("isin provider not implemented");
}

async function fetchWithFallback(symbol, type) {
  const chain = type === "isin" ? [fetchIsin] : [fetchYahoo, fetchStooq];
  const errors = [];
  for (const fn of chain) {
    try {
      return await fn(symbol);
    } catch (err) {
      errors.push(`${fn.name}: ${err.message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

/* ---------- main ---------- */

async function main() {
  const config = JSON.parse(await readFile(CONFIG, "utf8"));
  let symbols = [...collectSymbols(config)];
  if (ONLY) symbols = symbols.filter(([s]) => ONLY.has(s));

  const store =
    existsSync(STORE) && !DRY
      ? JSON.parse(await readFile(STORE, "utf8"))
      : { series: {}, meta: {} };
  store.series ??= {};
  store.meta ??= {};

  const date = today();
  const ok = [];
  const failures = [];

  for (const [symbol, type] of symbols) {
    try {
      const q = await fetchWithFallback(symbol, type);

      const series = (store.series[symbol] ??= []);
      const row = [date, Number(q.price.toFixed(6))];
      const at = series.findIndex((r) => r[0] === date);
      if (at >= 0) series[at] = row;
      else series.push(row);
      series.sort((a, b) => a[0].localeCompare(b[0]));

      store.meta[symbol] = { currency: q.currency, lastAsOf: q.asOf, via: q.via };
      ok.push(symbol);
      console.log(
        `ok   ${symbol.padEnd(16)} ${String(q.price).padStart(10)} ` +
          `${(q.currency ?? "").padEnd(4)} via ${q.via} (${q.asOf})`
      );
    } catch (err) {
      failures.push(`${symbol}: ${err.message}`);
      console.error(`FAIL ${symbol.padEnd(16)} ${err.message}`);
    }
  }

  console.log(`\n${ok.length}/${symbols.length} symbols resolved.`);

  if (DRY) {
    console.log("--dry-run: nothing written.");
    return;
  }

  store.lastUpdated = new Date().toISOString();
  store.failures = failures;
  await writeFile(STORE, JSON.stringify(store, null, 2) + "\n");

  if (!ok.length) {
    console.error("Every symbol failed - not committing an empty update.");
    process.exit(1);
  }
  if (failures.length) {
    console.warn(`\n${failures.length} failed:`);
    failures.forEach((f) => console.warn(`  - ${f}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
