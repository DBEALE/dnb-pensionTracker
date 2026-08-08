#!/usr/bin/env node
/**
 * Fetches proxy prices for every symbol referenced in config/funds.json and
 * appends today's close to data/prices.json.
 *
 * Runs in GitHub Actions. No dependencies - Node 20+ built-in fetch only.
 *
 * Providers:
 *   yahoo  - LSE-listed ETFs (VAPX.L etc). Unofficial endpoint, no API key.
 *   isin   - Aviva/Phoenix insured pension funds. See fetchIsin() - needs wiring
 *            to whichever source you settle on. Left deliberately explicit
 *            rather than guessing at an undocumented endpoint.
 *
 * Idempotent: re-running on the same day overwrites that day's entry rather
 * than duplicating it, so a re-run after a failure is safe.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const CONFIG = "config/funds.json";
const STORE = "data/prices.json";

const today = () => new Date().toISOString().slice(0, 10);

/** Collect every distinct symbol the config depends on, tagged with provider. */
function collectSymbols(config) {
  const out = new Map();
  for (const pot of config.pots) {
    for (const fund of pot.funds ?? []) {
      const type = fund.proxy?.type ?? "yahoo";
      for (const c of fund.proxy?.components ?? []) {
        if (!c.symbol) continue;
        out.set(c.symbol, type);
      }
    }
  }
  return out;
}

async function fetchYahoo(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=5d&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (pension-tracker)" },
  });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`${symbol}: no chart result`);

  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const stamps = result.timestamp ?? [];
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) {
      return {
        price: closes[i],
        currency: result.meta?.currency ?? null,
        asOf: new Date(stamps[i] * 1000).toISOString().slice(0, 10),
      };
    }
  }
  throw new Error(`${symbol}: no non-null close in window`);
}

/**
 * Aviva / Phoenix insured funds, looked up by ISIN.
 *
 * Not wired up yet, and deliberately so - the Aviva Fund Centre is a JS app
 * backed by an undocumented API at aviva-fundcentre.longboatanalytics.com.
 * Open the fund page with browser devtools on the Network tab, find the JSON
 * request carrying the daily price, and implement it here. Same idea for any
 * commercial data API you'd rather pay for (EODHD indexes these as
 * <ISIN>.EUFUND, free tier is ~20 requests/day which is enough for 4 funds).
 *
 * Until then these return null and the site falls back to the last manually
 * entered price, flagging the fund as stale.
 */
async function fetchIsin(isin) {
  return null;
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG, "utf8"));
  const symbols = collectSymbols(config);

  const store = existsSync(STORE)
    ? JSON.parse(await readFile(STORE, "utf8"))
    : { series: {}, meta: {} };
  store.series ??= {};
  store.meta ??= {};

  const date = today();
  const failures = [];

  for (const [symbol, type] of symbols) {
    try {
      const quote =
        type === "isin" ? await fetchIsin(symbol) : await fetchYahoo(symbol);

      if (!quote) {
        failures.push(`${symbol} (${type}: not implemented)`);
        continue;
      }

      const series = (store.series[symbol] ??= []);
      const existing = series.findIndex((row) => row[0] === date);
      const row = [date, Number(quote.price.toFixed(6))];
      if (existing >= 0) series[existing] = row;
      else series.push(row);

      series.sort((a, b) => a[0].localeCompare(b[0]));
      store.meta[symbol] = { currency: quote.currency, lastAsOf: quote.asOf };

      console.log(`ok   ${symbol.padEnd(16)} ${quote.price} ${quote.currency ?? ""}`);
    } catch (err) {
      failures.push(`${symbol}: ${err.message}`);
      console.error(`FAIL ${symbol.padEnd(16)} ${err.message}`);
    }
  }

  store.lastUpdated = new Date().toISOString();
  store.failures = failures;

  await writeFile(STORE, JSON.stringify(store, null, 2) + "\n");

  // Fail loudly only if nothing at all came back - a single delisted or
  // renamed ticker shouldn't break the daily run and stop the site updating.
  if (failures.length === symbols.size) {
    console.error("\nEvery symbol failed - not committing a useless update.");
    process.exit(1);
  }
  if (failures.length) {
    console.warn(`\n${failures.length}/${symbols.size} symbols failed:`);
    failures.forEach((f) => console.warn(`  - ${f}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
