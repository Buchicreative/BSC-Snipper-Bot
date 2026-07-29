const logger = require('./logger');
const config = require('../config');

const BSC_CHAIN_ID = 56;
const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';

/**
 * Checks whether a token's source is verified on BscScan, via Etherscan's
 * unified V2 API. Informational only — plenty of legitimate brand-new
 * tokens are unverified in their first few minutes, so this isn't treated
 * as a hard block anywhere it's used, just a signal worth seeing.
 *
 * Requires ETHERSCAN_API_KEY (same key used by the holder concentration
 * check). Without one, or on any failure, returns { checked: false }.
 */
async function checkSourceVerified(tokenAddress) {
  if (!config.etherscanApiKey) {
    return { checked: false, reason: 'no_api_key' };
  }

  const url = `${ETHERSCAN_V2_BASE}?chainid=${BSC_CHAIN_ID}&module=contract&action=getsourcecode&address=${tokenAddress}&apikey=${config.etherscanApiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Etherscan API returned ${res.status}`);
    }
    const data = await res.json();

    if (data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) {
      return { checked: false, reason: data.message || 'no_data' };
    }

    const entry = data.result[0];
    const sourceVerified = Boolean(entry.SourceCode && entry.SourceCode.length > 0);
    const isProxy = entry.Proxy === '1';

    return {
      checked: true,
      sourceVerified,
      isProxy,
      contractName: entry.ContractName || null,
    };
  } catch (err) {
    logger.warn('Contract verification check failed', { tokenAddress, error: err.message });
    return { checked: false, reason: err.message };
  }
}

module.exports = { checkSourceVerified };
