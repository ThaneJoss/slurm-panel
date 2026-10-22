import { readFileSync } from 'node:fs';

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
  const counts = {};
  for (const job of jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;

  function listJobs() {
    return structuredClone({
      jobs: jobs.map(({ attempts, logs, messages, ...job }) => job),
      workers: fixture.workers.map((worker) => ({ ...worker, heartbeat: Date.now() / 1000 - 2 })),
      counts,
      paused: false,
      manager_heartbeat: Date.now() / 1000 - 1,
      now: Date.now() / 1000,
    });
  }

  function getJob(id) {
    const result = jobs.find((job) => job.id === id);
    if (!result) return null;
    const { messages, ...job } = result;
    return structuredClone(job);
  }

  function getLog(id, key) {
    const job = jobs.find((item) => item.id === id);
    const source = job?.messages.find((item) => item.key === key);
    if (!source) return null;
    return { text: source.text, updated: job.updated, path: source.path };
  }

  return { listJobs, getJob, getLog, close() {} };
}
