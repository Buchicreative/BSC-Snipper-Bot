# BSC Sniper Bot (four.meme bonding curve — pump.fun-style)

Multi-user Telegram sniping bot for BSC, matching pump.fun's model: it snipes
**four.meme launches only**, bought and sold directly through the bonding
curve — same as how the Solana pump.fun sniper only trades pump.fun's own
curve, not post-graduation Raydium pairs. Any Telegram user on the allowlist
can register their own wallet (generate a new one, or import via private key
or seed phrase) and trade independently — their own settings, their own
wallet, their own positions, isolated from every other user on the same
deployment.

## Multi-user model

- **Per-user wallets** — `/generatewallet` creates a new one, or
  `/importwallet <privateKey or seed phrase>` brings your own. Private keys
  are encrypted at rest (AES-256-GCM) with a single master key
  (`WALLET_ENCRYPTION_KEY`) that only the deployment operator holds.
- **Per-user everything else** — trade size, gas reserve, max positions,
  liquidity/market cap/holder/tax thresholds, TP/SL, mode (paper/live), pause
  state, and circuit breaker are all independent per user. One person running
  aggressive live settings doesn't affect another person running conservative
  paper settings on the same bot.
- **Shared candidate discovery** — the expensive part (RPC calls, honeypot.is,
  Etherscan) runs once per discovered token, not once per user. Each
  registered user's own thresholds are then checked against that same data,
  cheaply, in a loop.
- **Admin allowlist** — only Telegram user IDs listed in
  `ALLOWED_TELEGRAM_USER_IDS` can register a wallet or trade. Everyone else
  gets a polite refusal.

**Security model, plainly stated:** this bot is custodial. It needs your raw
private key to sign transactions automatically, so whoever controls this
deployment (and its `WALLET_ENCRYPTION_KEY`) can technically access every
registered user's funds — the same trust model as any automated trading bot,
custodial exchange wallet, or copy-trading service. Keep only what you're
willing to risk in a bot-managed wallet, and move profits out to a wallet you
control directly. `/exportkey confirm` exists specifically so nothing is
trapped here permanently.

## What it watches

**four.meme launches only** — new token creation events on the four.meme
factory contract (BSC's dominant pump.fun-style bonding-curve launchpad).
Buys and sells execute directly against the bonding curve
(`TokenManager2.buyTokenAMAP` / `sellToken`) — not PancakeSwap.

A PancakeSwap-graduation listener exists in the codebase
(`src/listeners/pancakeGraduationListener.js`) but is **not started** —
disabled on purpose to keep this matching pump.fun's single-venue model. It
can be re-enabled in `src/index.js` if you ever want post-graduation sniping
back.

All position sizing and thresholds are **USD-denominated** (converted to BNB
at execution time via a live BNB/USD price feed), matching the Solana bot's
SOL-equivalent USD sizing.

## Telegram commands

| Command | Does |
|---|---|
| `/generatewallet` | create a new wallet for you (shows key once, auto-deletes after 60s) |
| `/importwallet <privateKey or seed phrase>` | use your own wallet instead |
| `/wallet` | show your address and BNB balance |
| `/exportkey confirm` | reveal your private key (auto-deletes after 60s) |
| `/deletewallet confirm` | remove your stored wallet from this bot |
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
| `/pause` | stop opening new positions for you |
| `/resume` | resume trading + reset your circuit breaker |
| `/mode <paper\|live>` | switch YOUR trading mode live, no restart needed |
| `/stop` | close all your positions and pause |
| `/closeall` | close all your positions but keep trading (no pause) |
| `/killswitch confirm` | stop the ENTIRE deployment for every user (not just you) |
| `/buy <token> <amountBnb>` | manual buy |
| `/sell <token> <amount>` | manual sell |
| `/settings` | view all your current thresholds at once |
| `/status` | your mode, pause state, position count, all thresholds |

## Status: paper-trading ready, live not yet recommended

Every safety check and every checklist item is now implemented. Nothing is
architecturally blocking `/mode live` — but two things are worth doing before
you trust it with real money:

- **Run it in paper mode first and watch the Telegram feed** for a while.
  Confirm it's catching real four.meme launches,
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
   `WALLET_ENCRYPTION_KEY` and `ALLOWED_TELEGRAM_USER_IDS` are required for
   anyone to register a wallet — generate the encryption key with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   and get Telegram IDs from @userinfobot. Trading mode is per-user now
   (defaults to paper) — each person switches their own via `/mode` in
   Telegram, no redeploy needed.
5. Railway will run `node src/index.js` per `railway.json`.
6. Attach a persistent volume so `data/bot.db` (every user's wallet, settings,
   positions, and stats) survives redeploys (Railway → your service →
   Settings → Volumes → mount at `/app/data`). **This one matters more now**
   — losing this volume means every registered user loses their stored
   wallet (recoverable only if they saved their own private key/seed phrase
   when they generated or imported it).

## Trading modes

Per-user, not global. Each person controls their own via `/mode <paper|live>`.

- `paper` (default for every new user) — simulates buys/sells, logs what
  would have happened, no real transactions.
- `live` — executes real swaps via that user's own registered wallet. Only
  switches if they've already registered a wallet (`/generatewallet` or
  `/importwallet`); refuses otherwise with a clear error.
