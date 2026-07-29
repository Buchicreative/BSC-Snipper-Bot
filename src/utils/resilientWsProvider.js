const { ethers } = require('ethers');
const WebSocket = require('ws');
const logger = require('./logger');

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60000;

/**
 * Creates an ethers WebSocketProvider with automatic reconnect-with-backoff.
 *
 * Public BSC WSS endpoints (including free ones) drop connections and time
 * out periodically — that's normal, not a bug. But without this wrapper, an
 * unhandled 'error' event on the underlying WebSocket instance crashes the
 * entire Node process: this is Node's default behavior for any EventEmitter
 * 'error' event with no listener attached. That's exactly what took the bot
 * down after its first RPC hiccup — the WebSocket errored, nothing was
 * listening for 'error', and Node threw it as an uncaught exception.
 *
 * onReady(provider) is called every time a connection is established (the
 * first time, and again after every reconnect). Attach your contract
 * listeners inside it and return a cleanup function — it's called
 * automatically right before the next reconnect's onReady fires, so you
 * don't end up with duplicate listeners across reconnects.
 */
function createResilientWsProvider(wssUrl, onReady) {
  let provider = null;
  let ws = null;
  let reconnectDelay = RECONNECT_DELAY_MS;
  let reconnectTimer = null;
  let stopped = false;
  let cleanupCurrent = () => {};

  function connect() {
    if (stopped) return;

    ws = new WebSocket(wssUrl);

    // Attached BEFORE anything else touches this socket — this is the fix.
    // A raw 'ws' WebSocket that errors with no 'error' listener causes
    // Node to throw it as an uncaught exception and kill the process.
    ws.on('error', (err) => {
      logger.error('WSS connection error', { url: wssUrl, error: err.message });
    });

    ws.on('open', () => {
      logger.info('WSS connected', { url: wssUrl });
      reconnectDelay = RECONNECT_DELAY_MS; // reset backoff after a healthy connect
    });

    ws.on('close', (code) => {
      logger.warn('WSS connection closed — reconnecting', {
        url: wssUrl,
        code,
        nextAttemptInMs: reconnectDelay,
      });
      cleanupCurrent();
      if (!stopped) {
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    });

    provider = new ethers.WebSocketProvider(ws);
    cleanupCurrent = onReady(provider) || (() => {});
  }

  connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      cleanupCurrent();
      if (ws) ws.terminate();
    },
  };
}

module.exports = { createResilientWsProvider };
