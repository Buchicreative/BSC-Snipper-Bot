const { ethers } = require('ethers');
const config = require('../config');
const logger = require('./logger');

let cachedPrice = null;
let cachedAt = 0;
const CACHE_MS = 30_000;

// Binance-Peg BSC-USD (USDT on BSC) — uses 18 decimals, same as WBNB.
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';

const FACTORY_ABI = ['function getPair(address tokenA, address tokenB) view returns (address pair)'];
const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
];

let onChainProvider = null;
function getProvider() {
  if (!onChainProvider) {
    onChainProvider = new ethers.JsonRpcProvider(config.rpc.http);
  }
  return onChainProvider;
}

/**
 * Reads the live BNB/USD price directly from the most liquid PancakeSwap
 * pair (WBNB/USDT) on-chain. This is the PRIMARY source now — Binance's
 * public price API (the original source here) blocks requests from many
 * datacenter IP ranges with an HTTP 451, including Railway's US-West region,
 * for regulatory reasons. That's not a transient outage; it's a standing
 * geo-block that would affect this bot on most US-based cloud hosts. On-chain
 * reads have no such restriction, and arguably reflect the exact price this
 * bot is actually trading against anyway.
 */
async function getOnChainBnbUsdPrice() {
  const provider = getProvider();
  const factory = new ethers.Contract(config.contracts.pancakeFactory, FACTORY_ABI, provider);
  const pairAddress = await factory.getPair(config.contracts.wbnb, USDT_ADDRESS);

  if (pairAddress === ethers.ZeroAddress) {
    throw new Error('WBNB/USDT pair not found');
  }

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = await pair.token0();

  const isToken0Wbnb = token0.toLowerCase() === config.contracts.wbnb.toLowerCase();
  const wbnbReserve = isToken0Wbnb ? reserve0 : reserve1;
  const usdtReserve = isToken0Wbnb ? reserve1 : reserve0;

  const wbnbAmount = parseFloat(ethers.formatEther(wbnbReserve));
  const usdtAmount = parseFloat(ethers.formatEther(usdtReserve));

  if (wbnbAmount === 0) throw new Error('Zero WBNB reserve in WBNB/USDT pair');
  return usdtAmount / wbnbAmount;
}

/**
 * Secondary fallback via CoinGecko's public API (no key needed) — only
 * used if the on-chain read itself fails (e.g. a transient RPC hiccup).
 */
async function getCoinGeckoBnbUsdPrice() {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd');
  if (!res.ok) throw new Error(`CoinGecko API returned ${res.status}`);
  const data = await res.json();
  const price = data?.binancecoin?.usd;
  if (!price) throw new Error('Invalid CoinGecko response shape');
  return price;
}

async function getBnbUsdPrice() {
  const now = Date.now();
  if (cachedPrice && now - cachedAt < CACHE_MS) {
    return cachedPrice;
  }

  try {
    const price = await getOnChainBnbUsdPrice();
    cachedPrice = price;
    cachedAt = now;
    return price;
  } catch (onChainErr) {
    logger.warn('On-chain BNB/USD price read failed, trying CoinGecko fallback', {
      error: onChainErr.message,
    });
    try {
      const price = await getCoinGeckoBnbUsdPrice();
      cachedPrice = price;
      cachedAt = now;
      return price;
    } catch (fallbackErr) {
      logger.error('All BNB/USD price sources failed', { error: fallbackErr.message });
      if (cachedPrice) {
        logger.warn('Falling back to last cached BNB/USD price', { price: cachedPrice });
        return cachedPrice;
      }
      throw fallbackErr;
    }
  }
}

async function usdToBnb(usdAmount) {
  const price = await getBnbUsdPrice();
  return usdAmount / price;
}

async function bnbToUsd(bnbAmount) {
  const price = await getBnbUsdPrice();
  return bnbAmount * price;
}

module.exports = { getBnbUsdPrice, usdToBnb, bnbToUsd };
