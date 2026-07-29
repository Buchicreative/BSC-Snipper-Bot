const logger = require('./logger');
const config = require('../config');

const BSC_CHAIN_ID = 56;
const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';

// Addresses that legitimately hold a large share of supply and shouldn't
// count as "concentration risk" — the pair itself, burn addresses, and known
// lockers (LP tokens aside, a project sometimes locks raw token supply too).
function isExcludedHolder(address, extraExclusions = []) {
  const burnAddresses = [
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
  ];
  const normalized = address.toLowerCase();
  return (
    burnAddresses.includes(normalized) ||
    extraExclusions.some((a) => a && a.toLowerCase() === normalized)
  );
}

/**
 * Fetches the top token holders for a BSC token via Etherscan's unified V2
 * API (one key works across all EVM chains via the chainid parameter).
 * Requires ETHERSCAN_API_KEY to be set — without one, this returns
 * { checked: false } rather than throwing, same pattern as the honeypot
 * checker, so a missing/invalid key doesn't halt all trading.
 *
 * pairAddress (optional): excluded from the concentration calculation,
 * since the AMM pool holding a large share of supply is normal and healthy,
 * not a concentration risk the way a single wallet holding it would be.
 */
async function getTopHolderPercent(tokenAddress, totalSupplyRaw, { pairAddress } = {}) {
  if (!config.etherscanApiKey) {
    return { checked: false, reason: 'no_api_key' };
  }

  const url = `${ETHERSCAN_V2_BASE}?chainid=${BSC_CHAIN_ID}&module=token&action=tokenholderlist&contractaddress=${tokenAddress}&page=1&offset=20&apikey=${config.etherscanApiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Etherscan API returned ${res.status}`);
    }
    const data = await res.json();

    if (data.status !== '1' || !Array.isArray(data.result)) {
      // Common for brand-new tokens with no indexed holder data yet, or a
      // plan tier that doesn't include this endpoint.
      return { checked: false, reason: data.message || 'no_data' };
    }

    const holders = data.result
      .filter((h) => !isExcludedHolder(h.TokenHolderAddress, [pairAddress]))
      .map((h) => ({
        address: h.TokenHolderAddress,
        quantity: BigInt(h.TokenHolderQuantity),
      }));

    if (holders.length === 0 || totalSupplyRaw === 0n) {
      return { checked: false, reason: 'no_holders_after_exclusions' };
    }

    const topHolder = holders.reduce((max, h) => (h.quantity > max.quantity ? h : max), holders[0]);
    const topHolderPercent = Number((topHolder.quantity * 10000n) / totalSupplyRaw) / 100;

    return { checked: true, topHolderPercent, topHolderAddress: topHolder.address };
  } catch (err) {
    logger.warn('Holder concentration check failed', { tokenAddress, error: err.message });
    return { checked: false, reason: err.message };
  }
}

module.exports = { getTopHolderPercent };
