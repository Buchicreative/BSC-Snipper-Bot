# BSC Sniper Bot (four.meme + PancakeSwap graduation)

Standalone Telegram sniping bot for BSC. Separate project from the Solana/BSC
memebot — same architecture and feature set, rebuilt for this chain's
launchpad ecosystem, with command parity to the Solana pump.fun sniper.

## What it watches

1. **four.meme launches** — new token creation events on the four.meme factory
   contract (BSC's dominant pump.fun-style bonding-curve launchpad).
2. **PancakeSwap graduation** — new pair creation on PancakeSwap V2 factory,
   which is what happens when a four.meme token's bonding curve completes and
   it gets real liquidity.

All position sizing and thresholds are **USD-denominated** (converted to BNB
at execution time via a live BNB/USD price feed), matching the Solana bot's
SOL-equivalent USD sizing.

## Telegram commands (full parity with the Solana sniper)

| Command | Does |
|---|---|
| `/setsize <usd>` | $ per trade |
| `/setgasreserve <usd>` | $ always kept untouched as a gas buffer |
| `/setmaxpositions <n>` | max simultaneous open positions |
| `/setminliquidity <usd>` | minimum pool liquidity to buy |
| `/setmaxmarketcap <usd>` | skip tokens valued above this (0 = no cap) |
| `/setminmarketcap <usd>` | skip tokens valued below this (0 = no floor) |
| `/setmaxholderpercent <percent>` | max % one wallet can hold |
| `/settakeprofit <percent>` | gain % to auto-sell at |
| `/setstoploss <percent>` | loss % to auto-sell at |
| `/stats` | balance, trade count, spent/made/lost |
| `/balance` | show wallet BNB balance |
| `/positions` | show open positions |
| `/history` | show recent closed trades |
| `/clearhistory confirm` | permanently wipe trade history + stats |
| `/pause` | stop opening new positions |
| `/resume` | resume trading + reset circuit breaker |
| `/mode <paper\|live>` | switch trading mode live, no restart needed |
| `/stop` | close all positions and pause |
| `/closeall` | close all positions but keep trading (no pause) |
| `/killswitch confirm` | actually stop the deployment (not just pause) |
| `/buy <token> <amountBnb>` | manual buy |
| `/sell <token> <amount>` | manual sell |
| `/settings` | view all current thresholds at once |
| `/status` | mode, pause state, position count, all thresholds |

## Status: functional scaffold — NOT ready for live trading yet

Before flipping to `/mode live`, these MUST be finished:

- [ ] **Verify the exact TokenCreate field order.** The contract address
      (`0x5c952063c7fc8610FFDB798152D69F0B9550762b`, TokenManager2) and event
      name (`TokenCreate`) are now confirmed from multiple independent
      sources — Bitquery's BSC indexer docs, four.meme's own GitBook, and
      community tooling. What's *not* confirmed is the exact parameter
      order/types, because the contract is unverified on BscScan (no public
      source). Grab the authoritative ABI from four.meme's own download at
      https://four-meme.gitbook.io/four.meme/brand/protocol-integration
      (`TokenManager2.lite.abi`) and diff it against
      `src/listeners/fourMemeListener.js`, or decode one real transaction to
      confirm field order. The listener also logs raw undecoded logs from
      the contract as a diagnostic — if you see those but never see "new
      token detected," that's the signature mismatch surfacing.
- [ ] **Honeypot simulation.** `src/filters/safetyChecks.js` flags this as
      not-implemented. Needs an actual buy+sell simulation (e.g. via `eth_call`
      against the router, or a service like honeypot.is's API) before any live
      buy should be trusted.
- [ ] **Liquidity lock check.** Check LP token holder against known locker
      contracts (Unicrypt, PinkLock, Mudra, etc).
- [ ] **Holder concentration check.** `/setmaxholderpercent` is wired up and
      adjustable, but nothing evaluates it yet — needs a BscScan API call or an
      indexer to pull top holders.

### Already implemented and functional

- **Full command parity** with the Solana bot's command set (table above),
  all persisted in SQLite and adjustable live via Telegram — no restart needed
  for any of them, including `/mode`.
- **Auto-buy is live by default in PAPER mode** (safe — no real funds), same
  as the reference bot: it evaluates every candidate against liquidity, market
  cap, max positions, and (in live mode only) gas reserve, then opens a
  position and notifies you via Telegram — or tells you why it didn't
  (e.g. "at max positions, raise the limit with /setmaxpositions").
- **Circuit breaker** — 5 consecutive failed buy attempts auto-pauses the bot;
  `/resume` clears the counter.
- **Kill switch** — `/killswitch confirm` sets a persisted "killed" flag and
  exits the process immediately. On restart (including a Railway auto-restart),
  the bot checks this flag first and exits again rather than resuming — so a
  container restart alone can't silently undo a kill switch. **Caveat:** this
  can't stop Railway's restart policy from *trying* to restart the container;
  to fully halt the deployment, also stop/remove the service from the Railway
  dashboard. This is an honest limitation of a Node process controlling its
  own host.
- **USD-denominated sizing** via a live BNB/USD price feed (Binance public
  ticker, 30s cache, falls back to last known price on a fetch failure).
- **Market cap estimation** from PancakeSwap pair reserves (token price ×
  total supply), used for `/setmaxmarketcap` / `/setminmarketcap`.

## Local dev (if ever needed)

```bash
npm install
cp .env.example .env
# fill in .env
npm run dev
```

## Deploying to Railway

1. Push this repo to GitHub.
2. In Railway: New Project → Deploy from GitHub repo → select this repo.
3. Railway auto-detects Node via Nixpacks (no Dockerfile needed).
4. Add the variables from `.env.example` under Railway's Variables tab.
   Leave `TRADING_MODE=paper` until the safety checklist above is done —
   after boot, use `/mode` in Telegram to switch, no redeploy needed.
5. Railway will run `node src/index.js` per `railway.json`.
6. Attach a persistent volume if you want `data/bot.db` (positions, settings,
   bot state, stats) to survive redeploys (Railway → your service → Settings
   → Volumes → mount at `/app/data`).

## Trading modes

- `paper` (default) — simulates buys/sells, logs what would have happened, no
  real transactions. Use this until the safety-check checklist is complete.
- `live` — executes real swaps via the wallet in `WALLET_PRIVATE_KEY`. Only
  switch via `/mode live` once you've tested extensively in paper mode.
