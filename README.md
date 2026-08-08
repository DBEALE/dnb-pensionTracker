# dnb-pensionTracker

Static site on GitHub Pages. A scheduled Action fetches proxy prices each weekday, commits
them to `data/prices.json`, and the page charts your pot value and equity glide path.

No server, no login, no cost.

---

## Privacy model

**Nothing personal goes in the repository.** The repo holds fund metadata and public price
history only. Your unit counts live in `localStorage` in your browser and never leave the
device. Anyone who finds the Pages URL sees an empty shell.

The trade-off: you enter holdings once per device. Use **Export** to save a backup and
**Import** on your phone. `pension-holdings.SEED.json` is pre-filled with everything mapped
so far — import it and you're done. **Keep that file out of the repo** (it is already in
`.gitignore`).

---

## Setup

```bash
git init && git add . && git commit -m "initial"
gh repo create dnb-pensionTracker --public --source=. --push
```

Then in the repo: **Settings → Pages → Source: Deploy from a branch → `main` / root**, and
**Settings → Actions → General → Workflow permissions → Read and write**.

Run the workflow once by hand (**Actions → Update prices → Run workflow**) to seed price
history, then open the Pages URL and import your holdings.

---

## How valuation works

For each fund you store `units`, the `unit price` from your provider's app, and the date you
read it. Each day the site computes:

```
value = units × priceₐ × (proxy_today / proxy_at_date_a)
```

The proxy is a weighted basket of LSE-listed ETFs or, for Aviva, the fund's own ISIN. Errors
compound only from the date you last entered a price, so **re-anchor quarterly** and drift
stays negligible.

Accuracy by fund, flagged in the UI:

| Flag | Meaning |
|---|---|
| `exact` | Real fund price by ISIN (Aviva) |
| *(none)* | Passive fund, ETF tracking the same index — tracking error ~0.1–0.5%/yr |
| `approx` | Synthetic blend, no public price for the real fund. Re-anchor quarterly |
| `stale` | No proxy data; showing last entered price |

Two HSBC funds are benchmarked to **SONIA + a spread** — a cash target, not a replicable
index — so they get synthetic blends. Global Bonds is the largest single holding at £155K,
but its volatility is only 1.6–2.8%/yr, so absolute error stays small.

---

## Verifying proxies

Tickers in `config/funds.json` were chosen from fund factsheets but **not price-verified**.
Before trusting the numbers, check each resolves and is GBP-denominated:

```bash
node -e 'fetch("https://query1.finance.yahoo.com/v8/finance/chart/VAPX.L")
  .then(r=>r.json()).then(j=>console.log(j.chart.result[0].meta))'
```

Also unverified: the ISIN for **BlackRock World ex-UK Equity Index Tracker S6**
(`GB00B6VZKW79` is the MyM share class — the S6 may differ), and the equity/bond split
assumed for **Mixed Investment (40-85% shares) S6** (70/25/5 is an estimate; the sector
mandate allows anything from 40% to 85% equity, which moves the glide-path number
materially).

---

## Wiring up Aviva prices

`fetchIsin()` in `scripts/fetch-prices.mjs` is deliberately unimplemented. The Aviva Fund
Centre is a JS app backed by an undocumented API at `aviva-fundcentre.longboatanalytics.com`
— open a fund page with devtools on the Network tab, find the JSON request carrying the
daily price, and implement it. Alternatively EODHD indexes these as `<ISIN>.EUFUND` and its
free tier (~20 requests/day) covers all nine Aviva holdings.

Until then Aviva funds show as `stale` at their last entered price.

---

## Gotchas

- **Scheduled workflows are disabled after 60 days of repo inactivity.** The workflow
  touches `.keepalive` at the start of each month to prevent this.
- **HSBC dealing cut-off is 14:00 UK**; valuation is 17:00. Switches submitted after 14:00
  deal at the *next* day's price.
- **Aviva prices are the previous working day's close**, so the Aviva line lags HSBC by a day.
- The Yahoo endpoint is unofficial and unversioned. If it breaks, swap `fetchYahoo()` for
  Stooq or a paid API — everything else is insulated from that choice.

---

## Still to add

Phoenix/Custard (plan 413466001M, ~£58K) and Standard Life (policy H81338 18, ~£9K). The
Standard Life holding is 93% closed With Profits with no daily published price, so it stays
a manual quarterly entry.

---

*Not financial advice. Values are estimates between quarterly re-anchor points.*
