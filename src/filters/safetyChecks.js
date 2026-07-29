const { ethers } = require('ethers');
const config = require('../config');
const settings = require('../utils/settings');
const priceFeed = require('../utils/priceFeed');
const honeypotChecker = require('../utils/honeypotChecker');
const liquidityLock = require('../utils/liquidityLock');
const holderConcentration = require('../utils/holderConcentration');
const contractVerification = require('../utils/contractVerification');
const logger = require('../utils/logger');

const ERC20_ABI = [
  'function owner() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
];

const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
];

/**
 * Reads a token's PancakeSwap pair reserves. Returns null if no pair exists
 * yet (e.g. a token still on the four.meme bonding curve, pre-graduation).
 */
async function getPairReserves(tokenAddress, provider) {
  const factory = new ethers.Contract(config.contracts.pancakeFactory, FACTORY_ABI, provider);
  const pairAddress = await factory.getPair(tokenAddress, config.contracts.wbnb);

  if (pairAddress === ethers.ZeroAddress) {
    return null; // No PancakeSwap pair yet — still bonding-curve only.
  }

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = await pair.token0();

  const isToken0Wbnb = token0.toLowerCase() === config.contracts.wbnb.toLowerCase();
  const wbnbReserve = isToken0Wbnb ? reserve0 : reserve1;
  const tokenReserve = isToken0Wbnb ? reserve1 : reserve0;

  return {
    pairAddress,
    wbnbReserveBnb: parseFloat(ethers.formatEther(wbnbReserve)),
    tokenReserveRaw: tokenReserve, // still in raw token decimals
  };
}

/**
 * Estimates liquidity (BNB-side reserve, converted to USD) and market cap
 * (token price implied by the pair, times total supply, converted to USD).
 * Both return 0 if there's no PancakeSwap pair yet.
 */
async function getLiquidityAndMarketCapUsd(tokenAddress, provider) {
  const reserves = await getPairReserves(tokenAddress, provider);
  if (!reserves) {
    return { liquidityUsd: 0, marketCapUsd: 0, pairAddress: null };
  }

  const bnbUsdPrice = await priceFeed.getBnbUsdPrice();
  const liquidityUsd = reserves.wbnbReserveBnb * bnbUsdPrice;

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [totalSupplyRaw, decimals] = await Promise.all([token.totalSupply(), token.decimals()]);

  const tokenReserveFormatted = parseFloat(
    ethers.formatUnits(reserves.tokenReserveRaw, decimals)
  );
  const totalSupplyFormatted = parseFloat(ethers.formatUnits(totalSupplyRaw, decimals));

  let marketCapUsd = 0;
  if (tokenReserveFormatted > 0) {
    const tokenPriceBnb = reserves.wbnbReserveBnb / tokenReserveFormatted;
    marketCapUsd = tokenPriceBnb * totalSupplyFormatted * bnbUsdPrice;
  }

  return { liquidityUsd, marketCapUsd, pairAddress: reserves.pairAddress };
}

/**
 * Runs a battery of safety checks on a candidate token before buying.
 * Returns { passed: boolean, report: {...}, reasons: [...] }
 *
 * These checks are heuristic, not a guarantee — always paper-trade new
 * logic before flipping /mode to live.
 */
async function runSafetyChecks(tokenAddress, provider) {
  const reasons = [];
  const report = {};
  let pairAddressForLockCheck = null;

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  // 1. Ownership check — is ownership renounced?
  try {
    const owner = await token.owner();
    report.owner = owner;
    if (owner !== ethers.ZeroAddress) {
      reasons.push('ownership_not_renounced');
    }
  } catch {
    // No owner() function — could be fine (no ownership pattern) or a proxy; note it.
    report.owner = 'unknown';
  }

  // 2. Liquidity + market cap checks (USD-denominated, matching /setminliquidity,
  // /setmaxmarketcap, /setminmarketcap). Only meaningful post-graduation —
  // four.meme tokens pre-graduation won't have a PancakeSwap pair yet, so
  // both read as 0 and get rejected by minLiquidityUsd until they graduate.
  // Resolves the pair address, reused below by the holder concentration and
  // liquidity lock checks.
  try {
    const { liquidityUsd, marketCapUsd, pairAddress } = await getLiquidityAndMarketCapUsd(tokenAddress, provider);
    pairAddressForLockCheck = pairAddress;
    const minLiquidity = settings.get('minLiquidityUsd');
    const maxMarketCap = settings.get('maxMarketCapUsd');
    const minMarketCap = settings.get('minMarketCapUsd');

    report.liquidityUsd = liquidityUsd;
    report.marketCapUsd = marketCapUsd;
    report.minLiquidityRequired = minLiquidity;

    if (liquidityUsd < minLiquidity) {
      reasons.push('liquidity_below_minimum');
    }
    if (maxMarketCap > 0 && marketCapUsd > maxMarketCap) {
      reasons.push('market_cap_above_maximum');
    }
    if (minMarketCap > 0 && marketCapUsd < minMarketCap) {
      reasons.push('market_cap_below_minimum');
    }
  } catch (err) {
    logger.warn('Liquidity/market cap read failed', { tokenAddress, error: err.message });
    reasons.push('liquidity_read_failed');
  }

  // 3. Holder concentration — is any single wallet over maxHolderPercent?
  // Real check via Etherscan's unified API (chainid=56 for BSC) — requires
  // ETHERSCAN_API_KEY to be set. Without a key, or if the call fails (rate
  // limit, plan tier, token too new to be indexed), this is a soft failure:
  // logged and visible in the report, doesn't block the buy on its own.
  try {
    const totalSupplyRaw = await token.totalSupply();
    const holderResult = await holderConcentration.getTopHolderPercent(tokenAddress, totalSupplyRaw, {
      pairAddress: pairAddressForLockCheck,
    });

    report.maxHolderPercent = settings.get('maxHolderPercent');

    if (holderResult.checked) {
      report.topHolderPercent = holderResult.topHolderPercent;
      report.topHolderAddress = holderResult.topHolderAddress;
      if (holderResult.topHolderPercent > settings.get('maxHolderPercent')) {
        reasons.push('holder_concentration_above_maximum');
      }
    } else {
      report.holderConcentrationCheckSkipped = holderResult.reason;
      reasons.push('holder_concentration_check_unavailable');
    }
  } catch (err) {
    logger.warn('Holder concentration check errored', { tokenAddress, error: err.message });
    reasons.push('holder_concentration_check_unavailable');
  }

  // 4. Honeypot + buy/sell tax check — actually simulates a buy+sell via
  // honeypot.is's public API, which catches contracts that let you buy but
  // block or heavily tax selling. This is a real simulation, not a static
  // heuristic, though it depends on a third-party service being up.
  try {
    const hp = await honeypotChecker.checkHoneypot(tokenAddress);
    report.honeypotChecked = hp.checked;

    if (hp.checked) {
      report.isHoneypot = hp.isHoneypot;
      report.honeypotReason = hp.honeypotReason;
      report.buyTaxPct = hp.buyTaxPct;
      report.sellTaxPct = hp.sellTaxPct;
      report.risk = hp.risk;
      report.riskLevel = hp.riskLevel;

      if (hp.isHoneypot === true) {
        reasons.push('honeypot_detected');
      }

      const maxBuyTax = settings.get('maxBuyTaxPct');
      const maxSellTax = settings.get('maxSellTaxPct');
      if (hp.buyTaxPct !== null && hp.buyTaxPct > maxBuyTax) {
        reasons.push('buy_tax_above_maximum');
      }
      if (hp.sellTaxPct !== null && hp.sellTaxPct > maxSellTax) {
        reasons.push('sell_tax_above_maximum');
      }
    } else {
      // Couldn't reach honeypot.is (rate limit, outage, or a token too new
      // for them to have indexed a pair yet). Treated as a soft failure —
      // logged and visible in the report, but doesn't block the buy on its
      // own, since an API outage shouldn't silently halt all trading.
      reasons.push('honeypot_check_unavailable');
    }
  } catch (err) {
    logger.warn('Honeypot check errored', { tokenAddress, error: err.message });
    reasons.push('honeypot_check_unavailable');
  }

  // 5. Liquidity lock check — what % of LP tokens sit in a known locker
  // contract or burn address (PinkLock, UNCX/Unicrypt, Team Finance, or
  // sent to a dead address)? This only recognizes the lockers it knows
  // about, so it's informational rather than a hard block: a 0% result
  // means "not locked by a locker we recognize," not "definitely unlocked."
  // No pair yet (pre-graduation) means nothing to check.
  if (pairAddressForLockCheck) {
    const lockedPercent = await liquidityLock.getLpLockedPercent(pairAddressForLockCheck, provider);
    report.lpLockedPercent = lockedPercent;
    if (lockedPercent === null) {
      reasons.push('liquidity_lock_unknown');
    } else if (lockedPercent < 50) {
      // Informational flag only — not in the critical-failure list below.
      reasons.push('liquidity_mostly_unlocked');
    }
  } else {
    report.lpLockedPercent = null;
    reasons.push('liquidity_lock_unknown');
  }

  // 6. Contract verification — is source verified on BscScan? Informational
  // only (not a critical failure) — plenty of legitimate brand-new tokens
  // are unverified in their first few minutes after launch. Requires
  // ETHERSCAN_API_KEY (same key as the holder concentration check).
  try {
    const verifyResult = await contractVerification.checkSourceVerified(tokenAddress);
    if (verifyResult.checked) {
      report.sourceVerified = verifyResult.sourceVerified;
      report.isProxy = verifyResult.isProxy;
      if (!verifyResult.sourceVerified) {
        reasons.push('source_not_verified');
      }
    } else {
      report.sourceVerified = null;
      report.contractVerificationCheckSkipped = verifyResult.reason;
    }
  } catch (err) {
    logger.warn('Contract verification check errored', { tokenAddress, error: err.message });
    report.sourceVerified = null;
  }

  const criticalFailures = reasons.filter((r) =>
    [
      'ownership_not_renounced',
      'liquidity_below_minimum',
      'market_cap_above_maximum',
      'market_cap_below_minimum',
      'honeypot_detected',
      'buy_tax_above_maximum',
      'sell_tax_above_maximum',
      'holder_concentration_above_maximum',
    ].includes(r)
  );

  const passed = criticalFailures.length === 0;

  logger.info('Safety check complete', { tokenAddress, passed, reasons });

  return { passed, report, reasons };
}

module.exports = { runSafetyChecks, getLiquidityAndMarketCapUsd };
