const { ethers } = require('ethers');
const logger = require('./logger');

// Known BSC LP locker contracts + burn addresses. Not exhaustive — there are
// smaller/newer lockers (Mudra, DxLock, various launchpad-native lockers)
// not covered here. A 0% result from this check means "not locked by a
// locker we know about," not "definitely unlocked."
const KNOWN_LOCKERS = {
  pinkLockV2: '0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe',
  pinkLockV1: '0x7ee058420e5937496f5a2096f04caa7721cf70cc',
  uncxNetwork: '0xc765bddb93b0d1c1a88282ba0fa6b2d00e3e0c83',
  teamFinance: '0x0c89c0407775dd89b12918b9c0aa42bf96518820',
  burnDead: '0x000000000000000000000000000000000000dEaD',
  burnZero: '0x0000000000000000000000000000000000000000',
};

const ERC20_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

/**
 * Checks what percentage of a PancakeSwap pair's LP token supply sits in
 * known locker contracts or burn addresses. Returns null if there's no
 * pair yet (pre-graduation four.meme tokens) or the check fails.
 *
 * This is a heuristic, not a guarantee: it only recognizes the lockers
 * listed above, and a legitimate lock through an unlisted locker will read
 * as 0% here.
 */
async function getLpLockedPercent(pairAddress, provider) {
  if (!pairAddress || pairAddress === ethers.ZeroAddress) {
    return null;
  }

  try {
    const lpToken = new ethers.Contract(pairAddress, ERC20_ABI, provider);
    const totalSupply = await lpToken.totalSupply();
    if (totalSupply === 0n) return null;

    const balances = await Promise.all(
      Object.values(KNOWN_LOCKERS).map((addr) => lpToken.balanceOf(addr).catch(() => 0n))
    );

    const lockedAmount = balances.reduce((sum, bal) => sum + bal, 0n);
    const lockedPercent = Number((lockedAmount * 10000n) / totalSupply) / 100;

    return lockedPercent;
  } catch (err) {
    logger.warn('LP lock check failed', { pairAddress, error: err.message });
    return null;
  }
}

module.exports = { getLpLockedPercent, KNOWN_LOCKERS };
