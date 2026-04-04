/**
 * ws.js — WebSocket client for phone-to-server communication.
 *
 * Provides a simple event-emitter-style interface so Svelte components
 * can subscribe to: 'queued', 'result', 'error', 'no_pc', 'open', 'close',
 * 'queue_update', 'progress'.
 *
 * Usage:
 *   import { createPhoneWS } from './ws.js';
 *   const ws = createPhoneWS(token);
 *   ws.on('result', ({ jobId, payload }) => { ... });
 *   ws.send({ type: 'submit', payload: encryptedBlob });
 *   ws.close();
 */

export function createPhoneWS(token) {
  const listeners = {};
  let socket = null;
  let closed = false;
  let failedAttempts = 0;
  let pingTimer = null;
  const MAX_RETRIES = 5;

  function on(event, handler) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(handler);
    return () => {
      listeners[event] = listeners[event].filter((h) => h !== handler);
    };
  }

  function emit(event, data) {
    (listeners[event] ?? []).forEach((h) => h(data));
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${location.host}/ws/phone?token=${encodeURIComponent(token)}`;
    socket = new WebSocket(url);

    socket.addEventListener('open', () => {
      failedAttempts = 0;
      emit('open', null);
      // Application-level keepalive — fires every 20 s to keep idle connections
      // alive through NAT/firewall/proxy idle timeouts.
      pingTimer = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20_000);
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.warn('[ws] Non-JSON message from server, ignoring.');
        return;
      }
      emit(msg.type, msg);
    });

    socket.addEventListener('close', (event) => {
      clearInterval(pingTimer);
      pingTimer = null;
      emit('close', event);
      if (closed) return;
      failedAttempts += 1;
      if (failedAttempts >= MAX_RETRIES) {
        console.warn(`[ws] ${MAX_RETRIES} reconnect attempts failed — giving up.`);
        emit('reconnect_failed', null);
        return;
      }
      const delay = Math.min(3000 * 2 ** (failedAttempts - 1), 30000) + Math.random() * 1000;
      console.log(`[ws] Reconnecting in ${delay / 1000}s (attempt ${failedAttempts})…`);
      setTimeout(connect, delay);
    });

    socket.addEventListener('error', (event) => {
      emit('ws_error', event);
    });
  }

  function send(obj) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('[ws] Cannot send — socket not open.');
      return false;
    }
    socket.send(JSON.stringify(obj));
    return true;
  }

  function close() {
    closed = true;
    clearInterval(pingTimer);
    pingTimer = null;
    socket?.close();
  }

  connect();

  return { on, send, close };
}
