const { ethers } = require('ethers');
const logger = require('./logger');

const TOKEN_MANAGER2_ADDRESS = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';
const HELPER3_ADDRESS = '0xF251F83e40a78868FcfA3FA4599Dad6494E46034';

// Confirmed via Bitquery's official sniper-bot documentation, which includes
// working code against this exact contract:
// https://docs.bitquery.io/docs/streams/sniper-trade-using-bitquery-kafka-stream/
const TOKEN_MANAGER2_ABI = [
  'function buyTokenAMAP(address token, address to, uint256 funds, uint256 minAmount) external payable',
  'function sellToken(address token, uint256 amount) external',
];

// Confirmed via codeslaw.app's bytecode-derived decompilation of
// TokenManagerHelper3, cross-checked against four.meme's own API writeup
// (emlahieu.blog) for field meanings.
const HELPER3_ABI = [
  'function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)',
  'function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

/**
 * Reads bonding-curve status for a four.meme token: version (must be 2 —
 * V1 tokens use a different, unsupported contract), how much has been
 * raised so far (funds/maxFunds, in wei of the quote token — BNB for the
 * large majority of tokens), and whether it has already graduated to
 * PancakeSwap (liquidityAdded — if true, this token should be traded via
 * the PancakeSwap-based Trader instead, not this module).
 */
async function getFourMemeTokenInfo(tokenAddress, provider) {
  const helper = new ethers.Contract(HELPER3_ADDRESS, HELPER3_ABI, provider);
  const info = await helper.getTokenInfo(tokenAddress);
  return {
    version: Number(info.version),
    tokenManager: info.tokenManager,
    quote: info.quote,
    lastPrice: info.lastPrice,
    launchTime: Number(info.launchTime),
    fundsRaisedWei: info.funds,
    maxFundsWei: info.maxFunds,
    liquidityAdded: info.liquidityAdded,
  };
}

/**
 * Buys a token still on four.meme's bonding curve (pre-graduation). Spends
 * exactly `fundsBnb` BNB via buyTokenAMAP, with a minimum-tokens-received
 * floor computed from tryBuy's estimate minus slippageBps — same pattern as
 * the PancakeSwap-side Trader's quote-then-buy flow.
 */
async function buyViaFourMeme(wallet, tokenAddress, fundsBnb, slippageBps = 300) {
  const fundsWei = ethers.parseEther(fundsBnb.toString());
  const helper = new ethers.Contract(HELPER3_ADDRESS, HELPER3_ABI, wallet.provider);

  let minAmount = 0n;
  try {
    const quote = await helper.tryBuy(tokenAddress, 0n, fundsWei);
    const slippageFactor = BigInt(10000 - slippageBps);
    minAmount = (quote.estimatedAmount * slippageFactor) / 10000n;
  } catch (err) {
    logger.warn('four.meme tryBuy quote failed, proceeding with minAmount = 0', {
      tokenAddress,
      error: err.message,
    });
  }

  const tokenManager2 = new ethers.Contract(TOKEN_MANAGER2_ADDRESS, TOKEN_MANAGER2_ABI, wallet);
  const tx = await tokenManager2.buyTokenAMAP(tokenAddress, wallet.address, fundsWei, minAmount, {
    value: fundsWei,
  });

  logger.info('four.meme buy tx submitted', { tokenAddress, txHash: tx.hash });
  const receipt = await tx.wait();
  logger.info('four.meme buy tx confirmed', { tokenAddress, txHash: tx.hash, block: receipt.blockNumber });

  return { simulated: false, tokenAddress, amountBnb: fundsBnb, txHash: tx.hash };
}

/**
 * Sells a token amount back through the bonding curve. Requires an ERC20
 * approve() first — TokenManager2 pulls the tokens via transferFrom, same
 * approve-then-act pattern as the PancakeSwap router.
 */
async function sellViaFourMeme(wallet, tokenAddress, tokenAmount) {
  const tokenRead = new ethers.Contract(tokenAddress, ERC20_ABI, wallet.provider);
  const tokenWrite = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

  const currentAllowance = await tokenRead.allowance(wallet.address, TOKEN_MANAGER2_ADDRESS);
  if (currentAllowance < tokenAmount) {
    const approveTx = await tokenWrite.approve(TOKEN_MANAGER2_ADDRESS, tokenAmount);
    await approveTx.wait();
  }

  const tokenManager2 = new ethers.Contract(TOKEN_MANAGER2_ADDRESS, TOKEN_MANAGER2_ABI, wallet);
  const tx = await tokenManager2.sellToken(tokenAddress, tokenAmount);

  logger.info('four.meme sell tx submitted', { tokenAddress, txHash: tx.hash });
  const receipt = await tx.wait();
  logger.info('four.meme sell tx confirmed', { tokenAddress, txHash: tx.hash, block: receipt.blockNumber });

  return { simulated: false, tokenAddress, txHash: tx.hash };
}

module.exports = {
  TOKEN_MANAGER2_ADDRESS,
  HELPER3_ADDRESS,
  getFourMemeTokenInfo,
  buyViaFourMeme,
  sellViaFourMeme,
};
