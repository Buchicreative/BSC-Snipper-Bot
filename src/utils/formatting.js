function shortAddr(address) {
  return address.slice(0, 10); // "0x" + 8 hex chars
}

function pnlEmoji(pnlPct) {
  return pnlPct >= 0 ? '🟢' : '🔴';
}

const CLOSE_REASON_LABELS = {
  manual: 'Manual /sell command',
  stop_command: 'Manual /stop command',
  closeall_command: 'Manual /closeall command',
  take_profit: '🎯 Take-profit hit',
  stop_loss: '🛑 Stop-loss hit',
};

function closeReasonLabel(reason) {
  return CLOSE_REASON_LABELS[reason] || reason;
}

// Dollar amounts (PnL, spent, made, lost) — always 2 decimals.
function formatUsd(n) {
  if (n === null || n === undefined) return 'n/a';
  return `$${n.toFixed(2)}`;
}

// Market cap — plain rounded integer, no decimals, no thousands separator
// (matches the reference bot's style: "$2126" not "$2,126.00").
function formatMc(n) {
  if (n === null || n === undefined) return 'n/a';
  return `$${Math.round(n)}`;
}

module.exports = { shortAddr, pnlEmoji, closeReasonLabel, formatUsd, formatMc };
