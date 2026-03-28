import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { initAuth, verifyPin, createSession, validateSession } from './auth.js';
import {
  createJob,
  completeJob,
  getJob,
  updateJobStatus,
  pruneOldJobs,
} from './jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Auth state ────────────────────────────────────────────────────────────────
// In-memory session store is handled inside auth.js.

// ── PC relay state ────────────────────────────────────────────────────────────
let pcSocket = null;
let pcPublicKeyB64 = null;

function sendJson(ws, obj) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(obj));
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

/** POST /auth — exchange PIN for a session token */
app.post('/auth', async (req, res) => {
  const { pin } = req.body ?? {};
  if (typeof pin !== 'string') {
    return res.status(400).json({ error: 'pin required' });
  }
  const ok = await verifyPin(pin);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }
  const token = createSession();
  res.json({ token });
});

/**
 * GET /pc-pubkey — serve the PC's cached public key so the phone can encrypt.
 * Requires a valid session (so random visitors can't probe the endpoint).
 */
app.get('/pc-pubkey', (req, res) => {
  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!validateSession(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!pcPublicKeyB64) {
    return res.status(503).json({ error: 'PC not connected' });
  }
  res.json({ publicKey: pcPublicKeyB64 });
});

/** GET /health — simple liveness check */
app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve the built Svelte client in production (local dev only — Caddy serves it on VPS).
  const clientDist = process.env.CLIENT_DIST_PATH || join(__dirname, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = createServer(app);

// ── WebSocket servers (noServer mode, we route upgrades manually) ─────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/ws/pc') {
    wss.handleUpgrade(req, socket, head, (ws) => handlePcSocket(ws));
    return;
  }

  if (url.pathname === '/ws/phone') {
    const token = url.searchParams.get('token');
    if (!validateSession(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handlePhoneSocket(ws));
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

// ── PC socket handler ─────────────────────────────────────────────────────────
async function handlePcSocket(ws) {
  console.log('[pc] Connecting — waiting for auth handshake...');

  const authTimeout = setTimeout(() => {
    console.warn('[pc] Auth timed out.');
    ws.close(4001, 'Auth timeout');
  }, 10_000);

  ws.once('message', async (raw) => {
    clearTimeout(authTimeout);
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.close(4002, 'Invalid auth message');
      return;
    }

    if (msg.type !== 'auth' || typeof msg.pin !== 'string') {
      ws.close(4002, 'Expected auth message');
      return;
    }

    const ok = await verifyPin(msg.pin);
    if (!ok) {
      console.warn('[pc] Wrong PIN.');
      ws.close(4003, 'Invalid PIN');
      return;
    }

    console.log('[pc] Authenticated.');
    sendJson(ws, { type: 'auth_ok' });

    if (pcSocket && pcSocket.readyState === 1) {
      console.log('[pc] Replacing previous PC socket.');
      pcSocket.close(1000, 'Replaced by new connection');
    }
    pcSocket = ws;

    ws.on('message', handlePcMessage);
    ws.on('close', () => {
      console.log('[pc] Disconnected.');
      if (pcSocket === ws) pcSocket = null;
    });
  });
}

function handlePcMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.warn('[pc] Invalid JSON, ignoring.');
    return;
  }

  if (msg.type === 'pubkey') {
    pcPublicKeyB64 = msg.publicKey;
    console.log('[pc] Public key cached.');
    return;
  }

  if (msg.type === 'progress') {
    const job = getJob(msg.jobId);
    if (job?.phoneWs?.readyState === 1) {
      sendJson(job.phoneWs, {
        type: 'progress',
        jobId: msg.jobId,
        value: msg.value,
        max: msg.max,
        node: msg.node ?? null,
      });
    }
    return;
  }

  if (msg.type === 'result') {
    const job = getJob(msg.jobId);
    if (!job) {
      console.warn(`[pc] Result for unknown job ${msg.jobId}`);
      return;
    }
    completeJob(msg.jobId, msg.payload);
    if (job.phoneWs?.readyState === 1) {
      sendJson(job.phoneWs, { type: 'result', jobId: msg.jobId, payload: msg.payload });
    }
    console.log(`[pc] Job ${msg.jobId} completed.`);
    return;
  }

  if (msg.type === 'error') {
    const job = getJob(msg.jobId);
    if (job?.phoneWs?.readyState === 1) {
      sendJson(job.phoneWs, { type: 'error', jobId: msg.jobId, message: msg.message });
    }
    console.warn(`[pc] Error for job ${msg.jobId}: ${msg.message}`);
    return;
  }

  console.warn(`[pc] Unhandled message type: ${msg.type}`);
}

// ── Phone socket handler ──────────────────────────────────────────────────────
function handlePhoneSocket(ws) {
  console.log('[phone] Connected.');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (msg.type === 'submit') {
      handleJobSubmit(ws, msg);
    } else {
      sendJson(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => console.log('[phone] Disconnected.'));
}

function handleJobSubmit(phoneWs, msg) {
  if (!pcSocket || pcSocket.readyState !== 1) {
    sendJson(phoneWs, { type: 'no_pc' });
    return;
  }

  if (typeof msg.payload !== 'string') {
    sendJson(phoneWs, { type: 'error', message: 'Missing payload' });
    return;
  }

  const jobId = uuidv4();
  createJob(jobId, phoneWs);
  sendJson(phoneWs, { type: 'queued', jobId });
  sendJson(pcSocket, { type: 'job', jobId, payload: msg.payload });
  updateJobStatus(jobId, 'processing');
  console.log(`[relay] Job ${jobId} dispatched.`);
}

// ── Start ─────────────────────────────────────────────────────────────────────
await initAuth();

// Prune stale jobs every 10 minutes
setInterval(() => pruneOldJobs(30 * 60 * 1000), 10 * 60 * 1000);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
});
