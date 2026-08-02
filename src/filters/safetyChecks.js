const { ethers } = require('ethers');
const config = require('../config');
const priceFeed = require('../utils/priceFeed');
const honeypotChecker = require('../utils/honeypotChecker');
const liquidityLock = require('../utils/liquidityLock');
const holderConcentration = require('../utils/holderConcentration');
const contractVerification = require('../utils/contractVerification');
const fourMemeTrader = require('../utils/fourMemeTrader');
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
    tokenReserveRaw: tokenReserve,
  };
}

async function getLiquidityAndMarketCapUsd(tokenAddress, provider) {
  const reserves = await getPairReserves(tokenAddress, provider);
  if (!reserves) {
    return { liquidityUsd: 0, marketCapUsd: 0, tokenPriceUsd: 0, pairAddress: null };
  }

  const bnbUsdPrice = await priceFeed.getBnbUsdPrice();
  const liquidityUsd = reserves.wbnbReserveBnb * bnbUsdPrice;

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [totalSupplyRaw, decimals] = await Promise.all([token.totalSupply(), token.decimals()]);

  const tokenReserveFormatted = parseFloat(ethers.formatUnits(reserves.tokenReserveRaw, decimals));
  const totalSupplyFormatted = parseFloat(ethers.formatUnits(totalSupplyRaw, decimals));

  let marketCapUsd = 0;
  let tokenPriceUsd = 0;
  if (tokenReserveFormatted > 0) {
    const tokenPriceBnb = reserves.wbnbReserveBnb / tokenReserveFormatted;
    tokenPriceUsd = tokenPriceBnb * bnbUsdPrice;
    marketCapUsd = tokenPriceUsd * totalSupplyFormatted;
  }

  return { liquidityUsd, marketCapUsd, tokenPriceUsd, pairAddress: reserves.pairAddress };
}

/**
 * Gathers every raw fact about a candidate token ONCE — ownership, liquidity,
 * market cap, honeypot/tax simulation, LP lock %, holder concentration,
 * source verification. This is the expensive part (RPC calls + two external
 * APIs), and none of it depends on any individual user's thresholds, so it's
 * computed once per candidate and shared across every user's evaluation via
 * evaluateForUser() below — instead of repeating all these calls per user.
 */
async function gatherTokenData(tokenAddress, provider, source) {
  const data = { tokenAddress, source };
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  // Ownership
  try {
    data.owner = await token.owner();
  } catch {
    data.owner = 'unknown';
  }

  // Liquidity + market cap. For PancakeSwap graduation candidates, this
  // reads real pair reserves. For four.meme candidates still on the
  // bonding curve, there IS no PancakeSwap pair yet — that's expected, not
  // a failure — so we use the BNB raised into the bonding curve so far
  // (from TokenManagerHelper3) as the liquidity proxy instead. Market cap
  // isn't reliably computable pre-graduation without the exact bonding
  // curve formula, so it's marked unavailable rather than guessed at.
  if (source === 'fourmeme') {
    try {
      const info = await fourMemeTrader.getFourMemeTokenInfo(tokenAddress, provider);
      const bnbUsdPrice = await priceFeed.getBnbUsdPrice();
      const fundsRaisedBnb = parseFloat(ethers.formatEther(info.fundsRaisedWei));
      data.liquidityUsd = fundsRaisedBnb * bnbUsdPrice; // used as the liquidity proxy below
      data.fourMemeLiquidityAdded = info.liquidityAdded;
      data.pairAddress = null;

      try {
        const { priceUsdPerToken, marketCapUsd } = await fourMemeTrader.getFourMemePriceAndMarketCapUsd(
          tokenAddress,
          provider,
          bnbUsdPrice
        );
        data.tokenPriceUsd = priceUsdPerToken;
        data.marketCapUsd = marketCapUsd;
      } catch (mcErr) {
        logger.warn('four.meme market cap derivation failed', { tokenAddress, error: mcErr.message });
        data.marketCapUsd = 0;
        data.marketCapUnavailable = true; // evaluateForUser skips min/max market cap checks
      }
    } catch (err) {
      logger.warn('four.meme bonding-curve data read failed', { tokenAddress, error: err.message });
      data.liquidityReadFailed = true;
    }
  } else {
    try {
      const { liquidityUsd, marketCapUsd, tokenPriceUsd, pairAddress } = await getLiquidityAndMarketCapUsd(tokenAddress, provider);
      data.liquidityUsd = liquidityUsd;
      data.marketCapUsd = marketCapUsd;
      data.tokenPriceUsd = tokenPriceUsd;
      data.pairAddress = pairAddress;
    } catch (err) {
      logger.warn('Liquidity/market cap read failed', { tokenAddress, error: err.message });
      data.liquidityReadFailed = true;
    }
  }

  // Holder concentration (needs ETHERSCAN_API_KEY; soft-fails otherwise)
  try {
    const totalSupplyRaw = await token.totalSupply();
    const holderResult = await holderConcentration.getTopHolderPercent(tokenAddress, totalSupplyRaw, {
      pairAddress: data.pairAddress,
    });
    if (holderResult.checked) {
      data.topHolderPercent = holderResult.topHolderPercent;
      data.topHolderAddress = holderResult.topHolderAddress;
    } else {
      data.holderConcentrationCheckSkipped = holderResult.reason;
    }
  } catch (err) {
    logger.warn('Holder concentration check errored', { tokenAddress, error: err.message });
    data.holderConcentrationCheckSkipped = err.message;
  }

  // Honeypot + tax simulation (honeypot.is)
  try {
    const hp = await honeypotChecker.checkHoneypot(tokenAddress);
    data.honeypotChecked = hp.checked;
    if (hp.checked) {
      data.isHoneypot = hp.isHoneypot;
      data.honeypotReason = hp.honeypotReason;
      data.buyTaxPct = hp.buyTaxPct;
      data.sellTaxPct = hp.sellTaxPct;
      data.risk = hp.risk;
      data.riskLevel = hp.riskLevel;
    }
  } catch (err) {
    logger.warn('Honeypot check errored', { tokenAddress, error: err.message });
    data.honeypotChecked = false;
  }

  // LP lock % (informational)
  if (data.pairAddress) {
    try {
      data.lpLockedPercent = await liquidityLock.getLpLockedPercent(data.pairAddress, provider);
    } catch (err) {
      logger.warn('LP lock check errored', { tokenAddress, error: err.message });
      data.lpLockedPercent = null;
    }
  } else {
    data.lpLockedPercent = null;
  }

  // Contract verification (informational)
  try {
    const verifyResult = await contractVerification.checkSourceVerified(tokenAddress);
    if (verifyResult.checked) {
      data.sourceVerified = verifyResult.sourceVerified;
      data.isProxy = verifyResult.isProxy;
    } else {
      data.sourceVerified = null;
    }
  } catch (err) {
    logger.warn('Contract verification check errored', { tokenAddress, error: err.message });
    data.sourceVerified = null;
  }

  return data;
}

/**
 * Cheap, synchronous evaluation of already-gathered token data against ONE
 * user's thresholds. Call gatherTokenData() once per candidate, then this
 * once per registered user — no repeated RPC/API calls.
 *
 * userSettings: the object returned by userSettings.getAll(chatId).
 * Returns { passed, reasons } — reasons includes both critical (blocking)
 * and informational (non-blocking) flags, same as before.
 */
function evaluateForUser(data, userSettings) {
  const reasons = [];

  // For four.meme tokens, the token contract is deployed BY TokenManager2 as
  // part of createToken(), and the full supply is minted into its custody to
  // run the bonding curve — so owner() returning TokenManager2's own address
  // is the normal, structurally-enforced state for every legitimate
  // four.meme token, not a rug-pull red flag the way an anonymous EOA owner
  // would be. Only flag ownership if it's some OTHER non-zero address.
  const ownerIsExpectedFourMemeCustodian =
    data.source === 'fourmeme' &&
    data.owner &&
    data.owner.toLowerCase() === fourMemeTrader.TOKEN_MANAGER2_ADDRESS.toLowerCase();

  if (
    data.owner &&
    data.owner !== ethers.ZeroAddress &&
    data.owner !== 'unknown' &&
    !ownerIsExpectedFourMemeCustodian
  ) {
    reasons.push('ownership_not_renounced');
  }

  if (data.liquidityReadFailed) {
    reasons.push('liquidity_read_failed');
  } else {
    if ((data.liquidityUsd ?? 0) < userSettings.minLiquidityUsd) {
      reasons.push('liquidity_below_minimum');
    }
    if (!data.marketCapUnavailable) {
      if (userSettings.maxMarketCapUsd > 0 && (data.marketCapUsd ?? 0) > userSettings.maxMarketCapUsd) {
        reasons.push('market_cap_above_maximum');
      }
      if (userSettings.minMarketCapUsd > 0 && (data.marketCapUsd ?? 0) < userSettings.minMarketCapUsd) {
        reasons.push('market_cap_below_minimum');
      }
    }
  }

  if (data.topHolderPercent !== undefined) {
    if (data.topHolderPercent > userSettings.maxHolderPercent) {
      reasons.push('holder_concentration_above_maximum');
    }
  } else {
    reasons.push('holder_concentration_check_unavailable');
  }

  if (data.honeypotChecked) {
    if (data.isHoneypot === true) {
      reasons.push('honeypot_detected');
    }
    if (data.buyTaxPct !== null && data.buyTaxPct !== undefined && data.buyTaxPct > userSettings.maxBuyTaxPct) {
      reasons.push('buy_tax_above_maximum');
    }
    if (data.sellTaxPct !== null && data.sellTaxPct !== undefined && data.sellTaxPct > userSettings.maxSellTaxPct) {
      reasons.push('sell_tax_above_maximum');
    }
  } else {
    reasons.push('honeypot_check_unavailable');
  }

  if (data.lpLockedPercent === null || data.lpLockedPercent === undefined) {
    reasons.push('liquidity_lock_unknown');
  } else if (data.lpLockedPercent < 50) {
    reasons.push('liquidity_mostly_unlocked'); // informational only
  }

  if (data.sourceVerified === false) {
    reasons.push('source_not_verified'); // informational only
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

  return { passed: criticalFailures.length === 0, reasons };
}

module.exports = { gatherTokenData, evaluateForUser, getLiquidityAndMarketCapUsd };
