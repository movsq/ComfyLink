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

/**
 * Server-originated message types the app actually handles. Anything else is
 * warned about and dropped, so the relay cannot reach the client's own
 * lifecycle events ('open', 'close', 'connection_state', 'reconnect_failed',
 * 'ws_error') — those are emitted by this module alone and must stay trusted.
 * 'auth_ok', 'auth_failed' and 'session_invalid' are handled before dispatch.
 */
const SERVER_EVENTS = new Set([
  'queued', 'result', 'error', 'no_pc', 'progress', 'queue_update',
  'job_recovery', 'code_status', 'code_refreshed', 'uses_updated', 'pong',
]);

export function createPhoneWS(token) {
  const listeners = {};
  let socket = null;
  let closed = false;
  let terminalReason = null;
  let failedAttempts = 0;
  let pingTimer = null;
  let reconnectTimer = null;
  let connectionState = 'connecting';
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

  function setConnectionState(nextState) {
    if (connectionState === nextState) return;
    connectionState = nextState;
    emit('connection_state', { state: connectionState, failedAttempts, reason: terminalReason });
  }

  function connect() {
    setConnectionState('connecting');
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    // Token is sent as the first WebSocket message (type: 'auth'), NOT in the URL,
    // so it is never written to proxy access logs.
    const url = `${protocol}://${location.host}/ws/phone`;
    socket = new WebSocket(url);

    socket.addEventListener('open', () => {
      // Send auth token as first message before starting keepalive
      socket.send(JSON.stringify({ type: 'auth', token }));
    });

    // The server will respond with { type: 'auth_ok' } on success or
    // { type: 'auth_failed' } followed by a close on failure.
    // Only emit 'open' once auth is confirmed.
    let authenticated = false;

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.warn('[ws] Non-JSON message from server, ignoring.');
        return;
      }

      if (!authenticated) {
        if (msg.type === 'auth_ok') {
          authenticated = true;
          terminalReason = null;
          failedAttempts = 0;
          setConnectionState('connected');
          emit('open', null);
          // Application-level keepalive — fires every 20 s to keep idle connections
          // alive through NAT/firewall/proxy idle timeouts.
          pingTimer = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'ping' }));
            }
          }, 20_000);
        } else if (msg.type === 'auth_failed') {
          console.warn('[ws] Auth rejected by server:', msg.reason);
          closed = true; // don't reconnect on auth failure
          terminalReason = msg.reason ?? 'auth_failed';
          setConnectionState('auth_invalid');
          emit('session_invalid', { reason: terminalReason });
          socket.close();
        }
        return;
      }

      if (msg.type === 'session_invalid') {
        terminalReason = msg.reason ?? 'session_invalid';
        closed = true;
        setConnectionState('auth_invalid');
        emit('session_invalid', { reason: terminalReason });
        try {
          socket.close(4003, 'Session invalid');
        } catch {
          // no-op
        }
        return;
      }

      if (!SERVER_EVENTS.has(msg.type)) {
        console.warn('[ws] Unknown message type from server, ignoring:', String(msg.type).slice(0, 64));
        return;
      }

      emit(msg.type, msg);
    });

    socket.addEventListener('close', (event) => {
      clearInterval(pingTimer);
      pingTimer = null;
      emit('close', event);

      if (!closed && event.code === 4003) {
        closed = true;
        terminalReason = terminalReason ?? 'session_invalid';
        setConnectionState('auth_invalid');
        emit('session_invalid', { reason: terminalReason });
        return;
      }

      if (closed) return;
      failedAttempts += 1;
      if (failedAttempts >= MAX_RETRIES) {
        console.warn(`[ws] ${MAX_RETRIES} reconnect attempts failed — giving up.`);
        setConnectionState('exhausted');
        emit('reconnect_failed', null);
        return;
      }
      setConnectionState('reconnecting');
      const delay = Math.min(3000 * 2 ** (failedAttempts - 1), 30000) + Math.random() * 1000;
      console.log(`[ws] Reconnecting in ${delay / 1000}s (attempt ${failedAttempts})…`);
      reconnectTimer = setTimeout(connect, delay);
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
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearInterval(pingTimer);
    pingTimer = null;
    setConnectionState('closed');
    socket?.close();
  }

  function reconnectNow() {
    if (closed) return;
    // A manual retry is a fresh start — otherwise "Retry Connection" after the
    // 5-attempt ceiling buys exactly one attempt before giving up again.
    failedAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        socket.close();
      } catch {
        // no-op
      }
      return;
    }
    connect();
  }

  connect();

  return { on, send, close, reconnectNow, getConnectionState: () => connectionState };
}
