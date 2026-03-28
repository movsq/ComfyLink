/**
 * ws.js — WebSocket client for phone-to-server communication.
 *
 * Provides a simple event-emitter-style interface so Svelte components
 * can subscribe to: 'queued', 'result', 'error', 'no_pc', 'open', 'close'.
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
      emit('open', null);
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
      emit('close', event);
      if (!closed) {
        // Auto-reconnect after 3 seconds
        setTimeout(connect, 3000);
      }
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
    socket?.close();
  }

  connect();

  return { on, send, close };
}
