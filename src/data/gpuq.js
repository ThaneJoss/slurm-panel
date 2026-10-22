import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { directoryCandidates, fileInfo, outputDirectories, progressFile, tail } from './files.js';

const JOB_COLUMNS = 'id, name, argv, cwd, state, created, updated, attempt_count, message';
const ATTEMPT_COLUMNS = `id, job_id, number, gpu, state, slurm_job_id, log_path,
  created, started, finished, exit_code, message`;
const PROGRESS_KEYS = ['progress_percent', 'updates', 'epoch', 'phase'];

function decodeJob(row) {
  const { environment, ...job } = row;
  job.argv = JSON.parse(job.argv);
  const submitted = JSON.parse(environment);
  // Only output directory hints are needed; submitted secrets stay out of the API.
  const outputs = {};
  for (const key of ['V6B_OUTPUT', 'OUTPUT_DIR', 'RUN_DIR', 'TRAIN_OUTPUT_DIR']) {
    if (submitted[key]) outputs[key] = submitted[key];
  }
  return { job, environment: outputs };
}

function belongsToJob(record, job) {
  const id = record.queue?.GPUQ_JOB_ID;
  return id == null || String(id) === String(job.id);
}

function normalizedProgress(record, source, updated) {
  const latest = record.latest ?? {};
  return {
    phase: record.state ?? record.phase ?? null,
    epoch: record.epoch ?? record.completed_epoch ?? null,
    batch: record.batch ?? null,
    batches: record.batches ?? record.updates_per_epoch ?? null,
    updates: record.updates ?? latest.updates ?? null,
    samples: record.samples ?? latest.samples ?? null,
    percent: record.progress_percent ?? null,
    loss:
      record.latest_loss ?? record.latest_micro_loss ?? record.latest_losses?.loss ?? latest.train_loss ?? null,
    images_per_second: record.training_images_per_second ?? null,
    budget_end: record.estimated_budget_end_at ?? record.deadline_at ?? null,
    updated,
    source,
  };
}

async function telemetry(job, attempt, directories) {
  const sources = [];
  if (attempt) {
    const result = await tail(attempt.log_path, 128 * 1024);
    if (result.updated !== null && result.updated >= job.created) {
      for (const line of result.text.split('\n').reverse()) {
        if (!line.startsWith('{')) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
        if (
          record !== null &&
          !Array.isArray(record) &&
          typeof record === 'object' &&
          PROGRESS_KEYS.some((key) => Object.hasOwn(record, key)) &&
          belongsToJob(record, job)
        ) {
          sources.push({ record, source: attempt.log_path, updated: result.updated });
          break;
        }
      }
    }
  }
  for (const directory of directories) {
    for (const filename of ['status.json', 'progress.json']) {
      const path = join(directory, filename);
      const result = await progressFile(path);
      if (result && result.updated >= job.created && belongsToJob(result.record, job)) {
        sources.push({ ...result, source: path });
      }
    }
  }
  if (sources.length === 0) return null;
  const latest = sources.reduce((best, item) => (item.updated > best.updated ? item : best));
  return normalizedProgress(latest.record, latest.source, latest.updated);
}

async function logSources(job, attempts, directories, environment) {
  const logs = attempts.map((attempt) => ({
    key: `attempt-${attempt.number}`,
    label: `尝试 ${attempt.number} · GPU ${attempt.gpu}`,
    path: attempt.log_path,
  }));
  const directoryIndexes = new Map(directoryCandidates(job, environment).map((path, index) => [path, index]));
  for (const directory of directories) {
    for (const name of ['run.log', 'train.log']) {
      const path = join(directory, name);
      const info = await fileInfo(path);
      if (info?.isFile() && info.mtimeMs / 1000 >= job.created) {
        const key = `project-${directoryIndexes.get(directory)}-${name.slice(0, -4)}`;
        logs.push({ key, label: `项目日志 · ${name}`, path });
      }
    }
  }
  return logs;
}

/** Read the gpuq schema directly, without importing or invoking its scheduler. */
export function createGpuqStore({ databasePath }) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 3000;');
  const jobsQuery = database.prepare(`SELECT ${JOB_COLUMNS}, environment FROM jobs ORDER BY id DESC LIMIT 200`);
  const jobQuery = database.prepare(`SELECT ${JOB_COLUMNS}, environment FROM jobs WHERE id = ?`);
  const latestAttempt = database.prepare(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE job_id = ? ORDER BY number DESC LIMIT 1`,
  );
  const attemptsQuery = database.prepare(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE job_id = ? ORDER BY number DESC`,
  );
  const workersQuery = database.prepare('SELECT gpu, slurm_job_id, heartbeat FROM workers ORDER BY gpu');
  const countsQuery = database.prepare('SELECT state, COUNT(*) AS count FROM jobs GROUP BY state');
  const metaQuery = database.prepare("SELECT key, value FROM meta WHERE key IN ('paused', 'manager_heartbeat')");

  async function publicJob(job, attempt, directories) {
    return { ...job, attempt: attempt ?? null, telemetry: await telemetry(job, attempt, directories) };
  }

  async function listJobs() {
    // Finish SQL reads before filesystem work so no read transaction blocks writers.
    const rows = jobsQuery.all().map((row) => ({ ...decodeJob(row), attempt: latestAttempt.get(row.id) }));
    const workers = workersQuery.all();
    const counts = Object.fromEntries(countsQuery.all().map((row) => [row.state, row.count]));
    const meta = Object.fromEntries(metaQuery.all().map((row) => [row.key, row.value]));
    const jobs = await Promise.all(
      rows.map(async ({ job, environment, attempt }) =>
        publicJob(job, attempt, await outputDirectories(job, environment)),
      ),
    );
    return {
      jobs,
      workers,
      counts,
      paused: meta.paused === '1',
      manager_heartbeat: Number(meta.manager_heartbeat ?? 0),
      now: Date.now() / 1000,
    };
  }

  async function getJob(id) {
    const row = jobQuery.get(id);
    if (!row) return null;
    const { job, environment } = decodeJob(row);
    const attempts = attemptsQuery.all(id);
    const directories = await outputDirectories(job, environment);
    return {
      ...(await publicJob(job, attempts[0], directories)),
      attempts,
      logs: await logSources(job, attempts, directories, environment),
    };
  }

  async function getLog(id, key) {
    const row = jobQuery.get(id);
    if (!row) return null;
    const { job, environment } = decodeJob(row);
    const attempts = attemptsQuery.all(id);
    const directories = await outputDirectories(job, environment);
    const logs = await logSources(job, attempts, directories, environment);
    const source = logs.find((item) => item.key === key);
    if (!source) return null;
    return { ...(await tail(source.path)), path: source.path };
  }

  return { listJobs, getJob, getLog, close: () => database.close() };
}
