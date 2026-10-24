# The Appraiser

A local, read-only advisor for Roblox limited-item trades on Windows. It watches your inbound trades, values every item, scores each offer from 0 to 100 and sends a desktop notification when an inbound trade scores well. A dark dashboard runs at `http://127.0.0.1:47615`.

**It never acts on a trade.** The code has no accept, decline, counter or send endpoints, and nothing automatic or bulk ever touches a trade. Counter suggestions are text only. You make every trade decision yourself on roblox.com/trades. A guard test (`src/core/no-trade-actions.test.ts`) fails the build if a trade-action or purchase endpoint ever appears in the source.

## Licence & use

This is **source-available, not open source**. You may read the code and run it for your own personal, non-commercial use. You may **not** modify and redistribute it, republish it, build derivative works or projects from it, or use it commercially without written permission from the copyright holder. See [LICENSE](LICENSE) for the full terms and [AI_POLICY.md](AI_POLICY.md) for how this applies to automated tools.

## What it does

- **Inbound** — every open inbound offer with a score, a verdict (Accept / Lean accept / Counter / Decline), an itemised explanation, risk flags and text-only counter suggestions. The tab shows a badge with the number of new offers.
- **Inventory** — your limiteds with value, RAP, liquidation value and an estimated trade-hold countdown for copies on hold.
- **My Trades** — completed trades with value at the time of the trade, value now, and profit/loss.
- **History** — decided offers with the score at the time and model-accuracy tracking.
- **Drops** — a read-only feed of newly released limiteds. Every link opens the roblox.com catalog page; you buy there yourself.
- **Market** — watchlist, market anomalies and inventory movers.
- **Settings** — scoring weights, overpay norms, polling intervals, notifications, hold list / wishlist / watchlist, and your cookie.
- **Demo mode** — the whole UI with made-up data, no cookie and no network.

## Requirements

- Windows 10 or 11
- Node 22 or newer, and npm

## Setup

```sh
npm install
npm run build
npm start            # serves the API and UI on http://127.0.0.1:47615
```

| Command | What it does |
|---|---|
| `npm run dev` | Runs the server (tsx watch) and the Vite UI together |
| `npm run build` | Builds the server and the UI into `dist/` |
| `npm start` | Runs the built server |
| `npm run real` | Launcher: builds if needed, starts the server (or reuses a running one) and opens the UI |
| `npm run shortcut` | Puts an "Appraiser" shortcut on your Desktop that runs the launcher |
| `npm test` | Runs the test suite |
| `npm run typecheck` | Type-checks the server and the web project |
| `npm run service:install` | Registers a per-user logon task (see below) |
| `npm run service:uninstall` | Removes the task and its launchers |

Environment variables:

- `PORT` — the port (default 47615; can also be changed in Settings).
- `RTA_DATA_DIR` — the data folder (default `%APPDATA%\the-appraiser`).
- `DEMO=1` (or `--demo`) — demo mode.
- `RTA_NO_NOTIFY=1` — no desktop notifications.

### Starting it

Double-click `scripts\start.cmd`, or from a terminal in the project folder:

```powershell
npm run real
```

Then open **Settings**, paste your cookie and save. The app checks whether your account can trade and loads your inventory.

### Background service (optional)

```sh
npm run build
npm run service:install
```

This creates a per-user Task Scheduler task (`Appraiser`) that starts 30 s after logon, runs hidden, restarts on failure and runs as you (not SYSTEM), so it can use your Windows credential store and show notifications. It also adds an `Appraiser.url` shortcut on your Desktop. Run `service:install` again if you change the port.

### Demo mode

```sh
npm run build
DEMO=1 npm start      # PowerShell: $env:DEMO=1; npm start
```

Demo mode loads made-up trades and items into a throwaway `demo.db` that is wiped on every start. It uses no cookie and makes no network calls to Roblox.

## Cookie safety

1. Paste your `.ROBLOSECURITY` value in **Settings → Roblox cookie**. It goes only to the local server on `127.0.0.1`.
2. It is stored in the Windows Credential Manager or, failing that, in a DPAPI-encrypted file in the data folder. It is never written in plain text, never logged (log lines are redacted) and the API only returns a masked version.
3. It is only ever sent to `https://*.roblox.com`. Redirects are refused, so it cannot be forwarded elsewhere.
4. If Roblox rotates the cookie, the new one is saved automatically.

**Same-machine caveat:** DPAPI and the credential store protect the cookie from other Windows users and from copies of the file. They do **not** protect it from malware running as your own user — anything running under your account can decrypt it, just as it could read your browser's cookies. Only use this on a PC you trust. To revoke access at any time, log out of all sessions on roblox.com.

## Read-only scope

The app only reads:

- Roblox trade lists, trade details, trade metadata and can-trade status for your own account
- your own collectibles inventory and your own purchase history (used only to estimate hold start times)
- public catalog, marketplace, resale and owner data
- public Rolimons item values, sales, deals and public trade-ad listings (read only, used as a demand signal; this app never posts ads)

It never accepts, declines, counters or sends trades, never buys anything, and never posts anything on your behalf.

## How scoring works (short version)

Each item gets a trade value from Rolimons value / demand / trend / projected flag, the Roblox marketplace floor and resellers, RAP and reconstructed sales, liquidity, momentum, rarity and serial premiums, with checks for projected (inflated) items, hoarding and thin history. A trade's score is a sigmoid over the value edge against an expected overpay norm, liquidity, momentum, demand shift, portfolio fit, risk penalties and confidence. Hard caps stop a risky trade from scoring as Accept, and every cap explains itself in the trade detail panel.

Default verdict bands: Accept ≥ 70, Lean accept ≥ 50, Counter ≥ 35, Decline below that. All weights, norms and thresholds are editable in Settings. The defaults are deliberately general-purpose; tune them for your own trading style.

## Limitations

- **Advice only.** You act on every trade yourself on roblox.com. There is no deep link to a single trade, so the UI shows the trade ID.
- **Community values.** Rolimons values are community estimates. The Rolimons sale feed only covers the last few minutes, so sales are missed while the app is off.
- **Hold length is estimated.** Roblox only says whether a copy is on hold, not for how long. The countdown uses an assumed length until it measures one.
- **Overpay norms are unsourced.** The defaults are assumptions; the learning panel suggests calibrated values once you have enough completed trades.
- **Drops are not instant.** Detection is limited by the catalog search rate limit and Roblox's own indexing lag.
- **Rate limits.** The app stays inside Roblox's published and observed limits, caches heavily and backs off on 429s, so some data refreshes slowly by design.
- **Roblox ToS.** Using your own cookie with a third-party tool is your choice and your risk. This project is not affiliated with or endorsed by Roblox or Rolimons.

## Licence

Copyright (c) 2026 Atheriar. All rights reserved except as granted in [LICENSE](LICENSE).
