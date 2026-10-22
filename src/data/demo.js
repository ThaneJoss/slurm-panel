import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { outputCandidates } from './files.js';
import { enrichJob, enrichWorkers, selectJobs } from './query.js';

/** A self-contained, entirely fictional queue for trying the UI. */
export function createDemoStore() {
  const fixture = JSON.parse(readFileSync(new URL('../../examples/demo.json', import.meta.url), 'utf8'));
  const now = Date.now() / 1000;
  const jobs = fixture.jobs.map((item) => {
    const { createdAgo, updatedAgo, attempts: records, telemetry: progress, logs: messages, ...fields } = item;
    const attempts = records.map(({ createdAgo: created, startedAgo, finishedAgo, ...attempt }) => ({
      ...attempt,
      job_id: fields.id,
      created: now - created,
      started: startedAgo == null ? null : now - startedAgo,
      finished: finishedAgo == null ? null : now - finishedAgo,
    }));
    const telemetry = progress ? { ...progress, updated: now - updatedAgo } : null;
    const logs = messages.map(({ text, ...source }) => source);
    return {
      ...fields,
      created: now - createdAgo,
      updated: now - updatedAgo,
      attempt_count: attempts.length,
      attempt: attempts[0] ?? null,
      telemetry,
      attempts,
      logs,
      messages,
    };
  });
  function listJobs(options = {}) {
    const timestamp = Date.now() / 1000;
    const all = jobs.map(({ attempts, logs, messages, ...job }) => enrichJob(job, timestamp));
    const metrics = (fixture.gpu_metrics ?? []).map(({ updatedAgo, ...record }) => ({
      ...record, updated: now - updatedAgo,
    }));
    return structuredClone({
      ...selectJobs(all, options, timestamp),
      workers: enrichWorkers(fixture.workers.map((worker) => ({ ...worker, heartbeat: timestamp - 2 })), all, metrics),
      paused: false,
      manager_heartbeat: Date.now() / 1000 - 1,
      now: timestamp,
    });
  }

  function getJob(id) {
    const result = jobs.find((job) => job.id === id);
    if (!result) return null;
    const { messages, ...job } = result;
    return structuredClone(enrichJob(job));
  }

  function getLog(id, key) {
    const job = jobs.find((item) => item.id === id);
    const source = job?.messages.find((item) => item.key === key);
    if (!source) return null;
    return { text: source.text, updated: job.updated, path: source.path };
  }

  function getLogSource(id, key) {
    const job = jobs.find((item) => item.id === id);
    const source = job?.logs.find((item) => item.key === key);
    return source ? structuredClone(source) : null;
  }

  function getArtifacts(id) {
    const job = jobs.find((item) => item.id === id);
    if (!job) return null;
    const directories = outputCandidates(job, {});
    const files = ['running', 'succeeded'].includes(job.state) ? directories.flatMap((directory) => [
      { name: 'status.json', path: join(directory, 'status.json'), size: 1536, modified: job.updated },
      { name: 'best.pt', path: join(directory, 'best.pt'), size: 24 * 1024 ** 2, modified: job.updated - 30 },
    ]) : [];
    return { directories, files, truncated: false };
  }

  function cancelJob(id) {
    const job = jobs.find((item) => item.id === id);
    if (!job) return null;
    if (['assigned', 'launching', 'starting', 'running', 'queued', 'waiting_resources'].includes(job.state)) {
      job.state = 'cancelled';
      job.updated = Date.now() / 1000;
      job.message = '此演示任务已取消';
      if (job.attempt) {
        job.attempt.state = 'cancelled';
        job.attempt.finished = job.updated;
      }
    }
    return getJob(id);
  }

  return { listJobs, getJob, getLog, getLogSource, getArtifacts, cancelJob, close() {} };
}
