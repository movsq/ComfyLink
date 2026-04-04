/**
 * In-memory job store with FIFO queue.
 * Jobs are ephemeral — lost on server restart. Fine for personal use.
 *
 * Job shape:
 * {
 *   id: string,
 *   status: 'pending' | 'processing' | 'done' | 'error' | 'cancelled',
 *   encryptedResult: Buffer | null,   // opaque blob, server never decrypts this
 *   createdAt: number,
 *   completedAt: number | null,       // when the job finished (for avg duration calc)
 *   phoneWs: WebSocket | null,        // the phone socket waiting for this result
 *   userId: string | null,            // anonymised owner identifier
 *   payload: string | null,           // encrypted payload to dispatch to PC
 * }
 */

const jobs = new Map();

/** Ordered job IDs — maintains FIFO queue order. */
const jobQueue = [];

/** Rolling durations of last 10 completed jobs (milliseconds). */
const completionDurations = [];
const MAX_DURATION_SAMPLES = 10;
const DEFAULT_AVG_DURATION_MS = 60_000; // 60s fallback

export function createJob(id, phoneWs, userId = null, payload = null) {
  const job = {
    id,
    status: 'pending',
    encryptedResult: null,
    createdAt: Date.now(),
    completedAt: null,
    phoneWs,
    userId,
    payload,
  };
  jobs.set(id, job);
  jobQueue.push(id);
  return job;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export function updateJobStatus(id, status) {
  const job = jobs.get(id);
  if (!job) return false;
  job.status = status;
  return true;
}

export function completeJob(id, encryptedResult) {
  const job = jobs.get(id);
  if (!job) return false;
  job.status = 'done';
  job.encryptedResult = encryptedResult;
  job.completedAt = Date.now();
  // Record duration for avg calculation (only if it was processing)
  if (job.createdAt) {
    completionDurations.push(job.completedAt - job.createdAt);
    if (completionDurations.length > MAX_DURATION_SAMPLES) completionDurations.shift();
  }
  return true;
}

export function deleteJob(id) {
  jobs.delete(id);
  const idx = jobQueue.indexOf(id);
  if (idx !== -1) jobQueue.splice(idx, 1);
}

/** Get the next pending job in FIFO order. */
export function getNextPendingJob() {
  for (const jid of jobQueue) {
    const job = jobs.get(jid);
    if (job && job.status === 'pending') return job;
  }
  return null;
}

/** Get the currently processing job (if any). */
export function getActiveJob() {
  for (const jid of jobQueue) {
    const job = jobs.get(jid);
    if (job && job.status === 'processing') return job;
  }
  return null;
}

/** Count non-terminal jobs for a given userId. */
export function getUserJobCount(userId) {
  let count = 0;
  for (const jid of jobQueue) {
    const job = jobs.get(jid);
    if (job && job.userId === userId && (job.status === 'pending' || job.status === 'processing')) {
      count++;
    }
  }
  return count;
}

/** Average job duration in seconds (rolling avg of last 10, default 60s). */
export function getAvgDurationSec() {
  if (completionDurations.length === 0) return DEFAULT_AVG_DURATION_MS / 1000;
  const sum = completionDurations.reduce((a, b) => a + b, 0);
  return Math.round(sum / completionDurations.length / 1000);
}

/**
 * Build the queue state to broadcast to phone sockets.
 * Only includes pending/processing jobs (not done/error/cancelled).
 * @param {string|null} forUserId - the recipient's userId to compute `isYours`
 * @returns {{ queue: Array, activeJobId: string|null, avgDuration: number }}
 */
export function getQueueState(forUserId = null) {
  const queue = [];
  let position = 0;
  let activeJobId = null;
  for (const jid of jobQueue) {
    const job = jobs.get(jid);
    if (!job) continue;
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') continue;
    position++;
    if (job.status === 'processing') activeJobId = job.id;
    queue.push({
      jobId: job.id,
      position,
      status: job.status,
      isYours: forUserId != null && job.userId === forUserId,
    });
  }
  return { queue, activeJobId, avgDuration: getAvgDurationSec() };
}

/** Remove terminal jobs from the queue array (cleanup). */
function cleanQueue() {
  for (let i = jobQueue.length - 1; i >= 0; i--) {
    const job = jobs.get(jobQueue[i]);
    if (!job || job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      jobQueue.splice(i, 1);
    }
  }
}

/** Prune jobs older than maxAgeMs to avoid unbounded memory growth. */
export function pruneOldJobs(maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > maxAgeMs) {
      jobs.delete(id);
    }
  }
  cleanQueue();
}
