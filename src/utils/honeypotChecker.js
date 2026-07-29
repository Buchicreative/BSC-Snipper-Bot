const logger = require('./logger');

const BSC_CHAIN_ID = 56;

/**
 * Calls honeypot.is's public simulation API, which actually simulates a
 * buy + sell of the token (not just static analysis) to catch contracts
 * that let you buy but block or heavily tax selling.
 *
 * No API key required as of this writing (honeypot.is has not yet turned
 * on their key system). If that changes, add HONEYPOT_API_KEY to .env and
 * pass it as an X-API-KEY header here.
 *
 * Returns a normalized result. On any failure to reach/parse the API,
 * returns { checked: false } rather than throwing — callers should decide
 * how to treat "couldn't check" (the current safetyChecks.js treats it as
 * a soft failure reason, not a hard block, since an API outage shouldn't
 * silently block all trading).
 */
async function checkHoneypot(tokenAddress) {
  const url = `https://api.honeypot.is/v2/IsHoneypot?address=${tokenAddress}&chainID=${BSC_CHAIN_ID}`;

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`honeypot.is returned ${res.status}`);
    }
    const data = await res.json();

    const isHoneypot = data?.honeypotResult?.isHoneypot ?? null;
    const honeypotReason = data?.honeypotResult?.honeypotReason ?? null;
    const buyTaxPct = data?.simulationResult?.buyTax ?? null;
    const sellTaxPct = data?.simulationResult?.sellTax ?? null;
    const transferTaxPct = data?.simulationResult?.transferTax ?? null;
    const risk = data?.summary?.risk ?? 'unknown';
    const riskLevel = data?.summary?.riskLevel ?? null;
    const simulationSuccess = data?.simulationSuccess ?? false;

    return {
      checked: true,
      simulationSuccess,
      isHoneypot,
      honeypotReason,
      buyTaxPct,
      sellTaxPct,
      transferTaxPct,
      risk,
      riskLevel,
    };
  } catch (err) {
    logger.warn('Honeypot check failed', { tokenAddress, error: err.message });
    return { checked: false, error: err.message };
  }
}

module.exports = { checkHoneypot };
