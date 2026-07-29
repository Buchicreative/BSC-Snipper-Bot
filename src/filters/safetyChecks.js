const { ethers } = require('ethers');
const config = require('../config');
const settings = require('../utils/settings');
const priceFeed = require('../utils/priceFeed');
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
    return { liquidityUsd: 0, marketCapUsd: 0 };
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

  return { liquidityUsd, marketCapUsd };
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

  // 2. Holder concentration — is any single wallet over maxHolderPercent?
  // NOTE: needs a BscScan API call or an indexer to pull top holders —
  // stub this in before relying on it live. Setting is wired up and
  // adjustable via /setmaxholderpercent, just not evaluated yet.
  report.maxHolderPercent = settings.get('maxHolderPercent');
  reasons.push('holder_concentration_check_not_implemented');

  // 3. Liquidity + market cap checks (USD-denominated, matching /setminliquidity,
  // /setmaxmarketcap, /setminmarketcap). Only meaningful post-graduation —
  // four.meme tokens pre-graduation won't have a PancakeSwap pair yet, so
  // both read as 0 and get rejected by minLiquidityUsd until they graduate.
  try {
    const { liquidityUsd, marketCapUsd } = await getLiquidityAndMarketCapUsd(tokenAddress, provider);
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

  // 4. Honeypot simulation — simulate a buy+sell via eth_call to catch
  // contracts that block selling. Requires a router simulation harness;
  // stub for now, must be implemented before live trading.
  report.honeypotSimulated = false;
  reasons.push('honeypot_check_not_implemented');

  // 5. Liquidity lock check — is LP locked (e.g. via a known locker contract)?
  // Requires checking LP token holder against known lockers (Unicrypt, PinkLock, etc).
  report.liquidityLockChecked = false;
  reasons.push('liquidity_lock_check_not_implemented');

  // 6. Contract verification — is source verified on BscScan?
  // Requires a BscScan API call; stub for now.
  report.sourceVerified = null;

  const criticalFailures = reasons.filter((r) =>
    [
      'ownership_not_renounced',
      'liquidity_below_minimum',
      'market_cap_above_maximum',
      'market_cap_below_minimum',
    ].includes(r)
  );

  const passed = criticalFailures.length === 0;

  logger.info('Safety check complete', { tokenAddress, passed, reasons });

  return { passed, report, reasons };
}

module.exports = { runSafetyChecks, getLiquidityAndMarketCapUsd };
