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
 *   userId: string | null,            // quota-accounting owner identifier (shared per code)
 *   ownerSessionId: string | null,    // per-WS session ID for cancel authorization
 *   payload: string | null,           // encrypted payload to dispatch to PC
 *   progress: { value: number, max: number, node: string|null, at: number } | null,
 * }
 */

const jobs = new Map();

/** Ordered job IDs — maintains FIFO queue order. */
const jobQueue = [];

/** Rolling durations of last 10 completed jobs (milliseconds). */
const completionDurations = [];
const MAX_DURATION_SAMPLES = 10;
const DEFAULT_AVG_DURATION_MS = 60_000; // 60s fallback

export function createJob(id, phoneWs, userId = null, ownerSessionId = null, payload = null) {
  const job = {
    id,
    status: 'pending',
    encryptedResult: null,
    createdAt: Date.now(),
    completedAt: null,
    phoneWs,
    userId,
    ownerSessionId,
    payload,
    progress: null,
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

export function completeJob(id, encryptedResult, thumbnail) {
  const job = jobs.get(id);
  if (!job) return false;
  job.status = 'done';
  job.encryptedResult = encryptedResult;
  job.thumbnail = thumbnail ?? null;
  job.completedAt = Date.now();
  // Record end-to-end duration for avg calculation (includes queue wait time)
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

/** Position of a non-terminal job in the current queue (1-based), null if absent. */
export function getJobPosition(jobId) {
  let position = 0;
  for (const jid of jobQueue) {
    const job = jobs.get(jid);
    if (!job) continue;
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') continue;
    position++;
    if (job.id === jobId) return position;
  }
  return null;
}

/** Recoverable jobs for a queue owner (pending + processing). */
export function getRecoverableJobsByUserId(userId) {
  const result = [];
  for (const jid of jobQueue) {
    const job = jobs.get(jid);
    if (!job || job.userId !== userId) continue;
    if (job.status === 'pending' || job.status === 'processing') {
      result.push(job);
    }
  }
  return result;
}

/** Completed jobs for an owner that can be replayed after reconnect. */
export function getCompletedJobsByUserId(userId) {
  const result = [];
  for (const job of jobs.values()) {
    if (!job || job.userId !== userId) continue;
    if (job.status === 'done' && job.encryptedResult != null) {
      result.push(job);
    }
  }
  // Oldest first keeps replay deterministic if multiple jobs finished while offline.
  result.sort((a, b) => (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt));
  return result;
}

/** Rebind a job to a newly reconnected owner socket/session. */
export function reclaimJob(jobId, phoneWs, ownerSessionId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.phoneWs = phoneWs;
  job.ownerSessionId = ownerSessionId;
  return true;
}

/** Cache latest progress for replay on reconnect. */
export function updateJobProgress(jobId, value, max, node = null) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.progress = { value, max, node, at: Date.now() };
  return true;
}

/** Stable queue snapshot for a specific job (owner-facing). */
export function getJobSnapshot(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return null;
  return {
    jobId: job.id,
    status: job.status,
    position: getJobPosition(job.id),
    isYours: true,
    progress: job.progress,
    createdAt: job.createdAt,
  };
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

/** Count all active (pending + processing) jobs across all users. */
export function getTotalActiveJobCount() {
  let count = 0;
  for (const jid of jobQueue) {
    const job = jobs.get(jid);
    if (job && (job.status === 'pending' || job.status === 'processing')) count++;
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
 * Public queue summary — aggregate counts only, no job IDs exposed.
 * Safe to send to every connected socket.
 * @returns {{ queueSize: number, avgDuration: number }}
 */
export function getPublicQueueState() {
  let queueSize = 0;
  for (const jid of jobQueue) {
    const job = jobs.get(jid);
    if (!job) continue;
    if (job.status === 'pending' || job.status === 'processing') queueSize++;
  }
  return { queueSize, avgDuration: getAvgDurationSec() };
}

/**
 * Private queue state for the job owner: includes per-job detail (jobId, position).
 * Only send this to the socket whose ownerSessionId matches.
 * @param {string} ownerSessionId - the WS session ID to match against
 * @returns {{ queue: Array, activeJobId: string|null, avgDuration: number }}
 */
export function getOwnerQueueState(ownerSessionId) {
  const queue = [];
  let position = 0;
  let activeJobId = null;
  for (const jid of jobQueue) {
    const job = jobs.get(jid);
    if (!job) continue;
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') continue;
    position++;
    if (job.ownerSessionId === ownerSessionId) {
      if (job.status === 'processing') activeJobId = job.id;
      queue.push({
        jobId: job.id,
        position,
        status: job.status,
        isYours: true,
      });
    }
  }
  return { queue, activeJobId, avgDuration: getAvgDurationSec() };
}

/**
 * @deprecated Use getPublicQueueState / getOwnerQueueState instead.
 * Kept for internal use during dispatchNextJob only.
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
