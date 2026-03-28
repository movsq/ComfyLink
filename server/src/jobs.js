/**
 * In-memory job store.
 * Jobs are ephemeral — lost on server restart. Fine for personal use.
 *
 * Job shape:
 * {
 *   id: string,
 *   status: 'pending' | 'processing' | 'done' | 'error',
 *   encryptedResult: Buffer | null,   // opaque blob, server never decrypts this
 *   createdAt: number,
 *   phoneWs: WebSocket | null,        // the phone socket waiting for this result
 * }
 */

const jobs = new Map();

export function createJob(id, phoneWs) {
  const job = {
    id,
    status: 'pending',
    encryptedResult: null,
    createdAt: Date.now(),
    phoneWs,
  };
  jobs.set(id, job);
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
  return true;
}

export function deleteJob(id) {
  jobs.delete(id);
}

/** Prune jobs older than maxAgeMs to avoid unbounded memory growth. */
export function pruneOldJobs(maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > maxAgeMs) {
      jobs.delete(id);
    }
  }
}
