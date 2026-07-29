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
| `/setmaxbuytax <percent>` | reject tokens with simulated buy tax above this |
| `/setmaxselltax <percent>` | reject tokens with simulated sell tax above this |
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

## Status: paper-trading ready, live not yet recommended

Every safety check and every checklist item is now implemented. Nothing is
architecturally blocking `/mode live` — but two things are worth doing before
you trust it with real money:

- **Run it in paper mode first and watch the Telegram feed** for a while.
  Confirm it's catching real four.meme launches and PancakeSwap graduations,
  and that the safety checks are behaving the way you expect.
- **Double-check the honeypot.is and Etherscan API responses hold up** under
  real traffic — both are third-party services this bot depends on, and
  their soft-failure handling (logged, non-blocking) means a quiet outage
  could reduce your effective filtering without stopping the bot outright.

The one thing that was a genuine open question — the exact `TokenCreate`
field order — is now resolved. Confirmed via
[`four-meme-community/four-meme-ai`](https://github.com/four-meme-community/four-meme-ai/blob/main/skills/four-meme-integration/references/event-listening.md),
an actively maintained open-source tool built against this exact contract:

```
event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)
```

None of the fields are indexed. This matches Bitquery's independently
documented field list for the same event, and is what's now in
`src/listeners/fourMemeListener.js`.

### Already implemented and functional

- **Full command parity** with the Solana bot's command set (table above),
  all persisted in SQLite and adjustable live via Telegram — no restart needed
  for any of them, including `/mode`.
- **Honeypot + tax detection** — `src/utils/honeypotChecker.js` calls
  honeypot.is's public API, which actually simulates a buy+sell of the token
  (not a static heuristic) to catch contracts that let you buy but block or
  heavily tax selling. `/setmaxbuytax` / `/setmaxselltax` gate on the real
  simulated tax percentages. If the API is unreachable, it's logged as a soft
  failure rather than silently blocking all trading — worth knowing if you
  see a run of skipped tokens with no other explanation.
- **Liquidity lock check** — `src/utils/liquidityLock.js` checks what % of a
  token's LP tokens sit in known BSC locker contracts (PinkLock V1/V2, UNCX
  Network/Unicrypt, Team Finance) or a burn address. This is informational,
  not a hard block: it only recognizes the lockers listed, so a 0% result
  means "not locked by a locker we know about," not "definitely unlocked" —
  visible in the safety report as `lpLockedPercent`, but doesn't block a buy
  on its own the way the honeypot/liquidity/market-cap checks do.
- **Holder concentration check** — `src/utils/holderConcentration.js` pulls
  the top holder list via Etherscan's unified V2 API (BSC is `chainid=56`,
  same key as every other EVM chain Etherscan covers) and rejects a token if
  any single wallet — excluding the AMM pair itself, which normally holds a
  large legitimate share — holds more than `/setmaxholderpercent`. **Requires
  `ETHERSCAN_API_KEY` in `.env`** (free tier from etherscan.io/apis); without
  one, this check is skipped as a soft failure rather than blocking all
  trading.
- **Contract verification** — `src/utils/contractVerification.js` checks
  whether the token's source is verified on BscScan via the same Etherscan
  unified API / key as the holder check. Informational only, not a hard
  block — plenty of legitimate tokens are unverified in their first few
  minutes after launch, so this is a signal to weigh, not a filter.
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
3. Railway auto-detects Node via Nixpacks (no Dockerfile needed). Requires
   Node 22.5+ (set in `package.json` engines) — needed for the built-in
   `node:sqlite` module. The database layer uses this instead of
   `better-sqlite3` specifically to avoid native-module build failures on
   hosts like Railway where the available Node version can outpace
   `better-sqlite3`'s prebuilt binaries and force a from-source compile
   (which needs a full C++ toolchain that isn't guaranteed to be present).
   You'll see a one-line `ExperimentalWarning: SQLite is an experimental
   feature` in the logs on startup — that's expected and harmless.
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
