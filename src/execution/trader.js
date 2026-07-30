const { ethers } = require('ethers');
const config = require('../config');
const logger = require('../utils/logger');
const fourMemeTrader = require('../utils/fourMemeTrader');

const ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

/**
 * One Trader per user, per operation — cheap to construct (just wraps a
 * couple of ethers.Contract instances), so no need to cache instances
 * across calls. wallet is an ethers.Wallet already connected to a provider
 * (from userWallets.getWallet(chatId, provider)), or null for a user who
 * hasn't registered a wallet yet (paper mode only, in that case).
 */
class Trader {
  constructor(provider, wallet, mode) {
    this.provider = provider;
    this.wallet = wallet;
    this.mode = mode; // 'paper' | 'live'

    if (wallet) {
      this.routerWithSigner = new ethers.Contract(config.contracts.pancakeRouter, ROUTER_ABI, wallet);
    }
    this.routerReadOnly = new ethers.Contract(config.contracts.pancakeRouter, ROUTER_ABI, provider);
  }

  async getWalletBalanceBnb() {
    if (!this.wallet) return 0;
    const balance = await this.provider.getBalance(this.wallet.address);
    return parseFloat(ethers.formatEther(balance));
  }

  async getTokenBalance(tokenAddress) {
    if (!this.wallet) return 0n;
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    return token.balanceOf(this.wallet.address);
  }

  async _gasPrice() {
    const feeData = await this.provider.getFeeData();
    const maxGasPrice = ethers.parseUnits(config.trading.maxGasPriceGwei.toString(), 'gwei');
    return feeData.gasPrice && feeData.gasPrice < maxGasPrice ? feeData.gasPrice : maxGasPrice;
  }

  async buy(tokenAddress, amountBnb, { slippageBps = 300, venue = 'pancake' } = {}) {
    if (this.mode === 'paper') {
      logger.info(`[PAPER] Simulated buy (${venue})`, { tokenAddress, amountBnb });
      return { simulated: true, tokenAddress, amountBnb, txHash: `paper-${Date.now()}` };
    }

    if (!this.wallet) {
      throw new Error('Cannot execute live buy: no wallet registered for this user');
    }

    if (venue === 'fourmeme') {
      return fourMemeTrader.buyViaFourMeme(this.wallet, tokenAddress, amountBnb, slippageBps);
    }

    const path = [config.contracts.wbnb, tokenAddress];
    const amountIn = ethers.parseEther(amountBnb.toString());

    let amountOutMin = 0n;
    try {
      const amounts = await this.routerReadOnly.getAmountsOut(amountIn, path);
      const expectedOut = amounts[1];
      const slippageFactor = BigInt(10000 - slippageBps);
      amountOutMin = (expectedOut * slippageFactor) / 10000n;
    } catch (err) {
      logger.warn('Could not fetch quote, proceeding with amountOutMin = 0', {
        tokenAddress,
        error: err.message,
      });
    }

    const deadline = Math.floor(Date.now() / 1000) + 60;
    const gasPrice = await this._gasPrice();

    const tx = await this.routerWithSigner.swapExactETHForTokens(
      amountOutMin,
      path,
      this.wallet.address,
      deadline,
      { value: amountIn, gasPrice }
    );

    logger.info('Buy tx submitted', { tokenAddress, txHash: tx.hash });
    const receipt = await tx.wait();
    logger.info('Buy tx confirmed', { tokenAddress, txHash: tx.hash, block: receipt.blockNumber });

    return { simulated: false, tokenAddress, amountBnb, txHash: tx.hash };
  }

  async sell(tokenAddress, tokenAmount, { slippageBps = 300, venue = 'pancake' } = {}) {
    if (this.mode === 'paper') {
      logger.info(`[PAPER] Simulated sell (${venue})`, { tokenAddress, tokenAmount: tokenAmount.toString() });
      return { simulated: true, tokenAddress, txHash: `paper-${Date.now()}` };
    }

    if (!this.wallet) {
      throw new Error('Cannot execute live sell: no wallet registered for this user');
    }

    if (venue === 'fourmeme') {
      return fourMemeTrader.sellViaFourMeme(this.wallet, tokenAddress, tokenAmount);
    }

    const path = [tokenAddress, config.contracts.wbnb];
    const tokenContractRead = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    const tokenContractWrite = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);

    const currentAllowance = await tokenContractRead.allowance(
      this.wallet.address,
      config.contracts.pancakeRouter
    );
    if (currentAllowance < tokenAmount) {
      const approveTx = await tokenContractWrite.approve(config.contracts.pancakeRouter, tokenAmount);
      await approveTx.wait();
    }

    let amountOutMin = 0n;
    try {
      const amounts = await this.routerReadOnly.getAmountsOut(tokenAmount, path);
      const expectedOut = amounts[1];
      const slippageFactor = BigInt(10000 - slippageBps);
      amountOutMin = (expectedOut * slippageFactor) / 10000n;
    } catch (err) {
      logger.warn('Could not fetch sell quote, proceeding with amountOutMin = 0', {
        tokenAddress,
        error: err.message,
      });
    }

    const deadline = Math.floor(Date.now() / 1000) + 60;
    const gasPrice = await this._gasPrice();

    const tx = await this.routerWithSigner.swapExactTokensForETH(
      tokenAmount,
      amountOutMin,
      path,
      this.wallet.address,
      deadline,
      { gasPrice }
    );

    logger.info('Sell tx submitted', { tokenAddress, txHash: tx.hash });
    const receipt = await tx.wait();
    logger.info('Sell tx confirmed', { tokenAddress, txHash: tx.hash, block: receipt.blockNumber });

    return { simulated: false, tokenAddress, txHash: tx.hash };
  }
}

module.exports = { Trader };
