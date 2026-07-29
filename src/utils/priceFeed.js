const logger = require('./logger');

let cachedPrice = null;
let cachedAt = 0;
const CACHE_MS = 30_000;

/**
 * Fetches the current BNB/USD price. Uses Binance's public ticker endpoint
 * (no API key needed). Cached for 30s to avoid hammering the API on every
 * safety check.
 */
async function getBnbUsdPrice() {
  const now = Date.now();
  if (cachedPrice && now - cachedAt < CACHE_MS) {
    return cachedPrice;
  }

  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
    if (!res.ok) throw new Error(`Binance API returned ${res.status}`);
    const data = await res.json();
    const price = parseFloat(data.price);
    if (!price || Number.isNaN(price)) throw new Error('Invalid price in response');
    cachedPrice = price;
    cachedAt = now;
    return price;
  } catch (err) {
    logger.error('Failed to fetch BNB/USD price', { error: err.message });
    if (cachedPrice) {
      logger.warn('Falling back to last cached BNB/USD price', { price: cachedPrice });
      return cachedPrice;
    }
    throw err;
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
