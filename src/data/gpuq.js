import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { directoryCandidates, fileInfo, outputDirectories, progressFile, tail } from './files.js';
import { artifactMetadata } from './artifacts.js';
import { enrichJob, enrichWorkers, parseQuery } from './query.js';
import { readGpuMetrics } from './metrics.js';

const JOB_COLUMNS = 'id, name, argv, cwd, state, created, updated, attempt_count, message';
const ATTEMPT_COLUMNS = `id, job_id, number, gpu, state, slurm_job_id, log_path,
  created, started, finished, exit_code, message`;
const PROGRESS_KEYS = ['progress_percent', 'updates', 'epoch', 'phase'];
const ACTIVE = ['assigned', 'launching', 'starting', 'running'];
const RANGE_SECONDS = { '24h': 86400, '7d': 604800, '30d': 2592000 };

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

function normalizedProgress(record, source, updated, updatedSource) {
  const latest = record.latest ?? {};
  return {
    phase: record.state ?? record.phase ?? null,
    epoch: record.epoch ?? record.completed_epoch ?? null,
    total_epochs: record.total_epochs ?? record.epochs ?? record.max_epochs ?? null,
    batch: record.batch ?? null,
    batches: record.batches ?? record.updates_per_epoch ?? null,
    updates: record.updates ?? latest.updates ?? null,
    samples: record.samples ?? latest.samples ?? null,
    percent: record.progress_percent ?? null,
    percent_kind: record.progress_percent == null ? null : (record.percent_kind ?? 'budget'),
    eta_seconds: record.eta_seconds ?? record.estimated_remaining_seconds ?? null,
    loss:
      record.latest_loss ?? record.latest_micro_loss ?? record.latest_losses?.loss ?? latest.train_loss ?? null,
    images_per_second: record.training_images_per_second ?? null,
    budget_end: record.estimated_budget_end_at ?? record.deadline_at ?? null,
    updated,
    updated_source: updatedSource,
    source,
  };
}

function progressRecordTime(record, created) {
  const value = record.timestamp ?? record.updated_at ?? record.time ?? record.updated;
  if (value == null) return null;
  let timestamp = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(timestamp) && typeof value === 'string') timestamp = Date.parse(value) / 1000;
  if (timestamp > 1e12) timestamp /= 1000;
  return Number.isFinite(timestamp) && timestamp >= created ? timestamp : null;
}

async function telemetry(job, attempt, directories, logObservations) {
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
          const key = `${job.id}:${attempt.number}:${attempt.log_path}`;
          const content = JSON.stringify(record);
          const previous = logObservations.get(key);
          const recordTime = progressRecordTime(record, job.created);
          const observation = recordTime !== null
            ? { content, updated: recordTime, updatedSource: 'record' }
            : previous?.content === content ? previous
              : { content, updated: Date.now() / 1000, updatedSource: 'observed' };
          logObservations.set(key, observation);
          sources.push({ record, source: attempt.log_path, ...observation });
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
        sources.push({ ...result, source: path, updatedSource: 'file' });
      }
    }
  }
  if (sources.length === 0) return null;
  const latest = sources.reduce((best, item) => {
    // A first observation cannot establish when an untimestamped log record was
    // emitted. Prefer timestamped records/progress files when they are available.
    if (best.updatedSource === 'observed' && item.updatedSource !== 'observed') return item;
    if (best.updatedSource !== 'observed' && item.updatedSource === 'observed') return best;
    return item.updated > best.updated ? item : best;
  });
  return normalizedProgress(latest.record, latest.source, latest.updated, latest.updatedSource);
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
export function createGpuqStore({ databasePath, metricsFile = null }) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const logObservations = new Map();
  database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 3000;');
  const activeJobsQuery = database.prepare(`SELECT ${JOB_COLUMNS}, environment FROM jobs
    WHERE state IN ('assigned', 'launching', 'starting', 'running') ORDER BY id DESC`);
  const jobQuery = database.prepare(`SELECT ${JOB_COLUMNS}, environment FROM jobs WHERE id = ?`);
  const latestAttempt = database.prepare(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE job_id = ? ORDER BY number DESC LIMIT 1`,
  );
  const attemptsQuery = database.prepare(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE job_id = ? ORDER BY number DESC`,
  );
  const workersQuery = database.prepare('SELECT gpu, slurm_job_id, heartbeat FROM workers ORDER BY gpu');
  const metaQuery = database.prepare("SELECT key, value FROM meta WHERE key IN ('paused', 'manager_heartbeat')");

  async function publicJob(job, attempt, directories) {
    return enrichJob({ ...job, attempt: attempt ?? null, telemetry: await telemetry(job, attempt, directories, logObservations) });
  }

  async function listJobs(options = {}) {
    const query = parseQuery(options);
    const now = Date.now() / 1000;
    // Finish SQL reads before filesystem work so no read transaction blocks writers.
    const rows = activeJobsQuery.all().map((row) => ({ ...decodeJob(row), attempt: latestAttempt.get(row.id) }));
    const workers = workersQuery.all();
    const meta = Object.fromEntries(metaQuery.all().map((row) => [row.key, row.value]));
    // Old history participates in filtering/counts without re-reading every old
    // experiment directory on each refresh. Only active and displayed jobs need IO.
    const activeJobs = await Promise.all(rows.map(async ({ job, environment, attempt }) => (
      publicJob(job, attempt, await outputDirectories(job, environment))
    )));
    const activeById = new Map(activeJobs.map((job) => [job.id, job]));
    const historyConditions = [];
    const historyValues = [];
    const since = RANGE_SECONDS[query.range] === undefined ? null : now - RANGE_SECONDS[query.range];
    if (since !== null) {
      historyConditions.push('created >= ?');
      historyValues.push(since);
    }
    const where = (conditions) => conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const counts = Object.fromEntries(database.prepare(
      `SELECT state, COUNT(*) AS count FROM jobs${where(historyConditions)} GROUP BY state`,
    ).all(...historyValues).map((row) => [row.state, row.count]));
    const staleJobs = activeJobs.filter((job) => job.stale && (since === null || job.created >= since));
    const summary = {
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      active: ACTIVE.reduce((sum, state) => sum + (counts[state] ?? 0), 0),
      queued: (counts.queued ?? 0) + (counts.waiting_resources ?? 0),
      succeeded: counts.succeeded ?? 0,
      failed: counts.failed ?? 0,
      cancelled: counts.cancelled ?? 0,
      stale: staleJobs.length,
    };

    const conditions = [...historyConditions];
    const values = [...historyValues];
    if (query.state === 'active') conditions.push("state IN ('assigned', 'launching', 'starting', 'running')");
    else if (query.state === 'queued') conditions.push("state IN ('queued', 'waiting_resources')");
    else if (query.state !== 'all') {
      conditions.push('state = ?');
      values.push(query.state);
    }
    if (query.q) {
      conditions.push('(instr(lower(name), lower(?)) > 0 OR instr(CAST(id AS TEXT), ?) > 0)');
      values.push(query.q, query.q);
    }
    if (query.staleOnly) {
      conditions.push(staleJobs.length ? `id IN (${staleJobs.map(() => '?').join(',')})` : '0');
      values.push(...staleJobs.map((job) => job.id));
    }
    const total = database.prepare(`SELECT COUNT(*) AS count FROM jobs${where(conditions)}`).get(...values).count;
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const order = query.sort === 'oldest' ? 'id ASC' : query.sort === 'newest' ? 'id DESC'
      : "CASE WHEN state IN ('assigned', 'launching', 'starting', 'running') THEN 0 ELSE 1 END, id DESC";
    const pageRows = database.prepare(`SELECT ${JOB_COLUMNS}, environment FROM jobs${where(conditions)}
      ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, query.pageSize, (page - 1) * query.pageSize);
    const selectedRows = pageRows.map((row) => ({ ...decodeJob(row), attempt: latestAttempt.get(row.id) }));
    const jobs = await Promise.all(selectedRows.map(async ({ job, environment, attempt }) => (
      activeById.get(job.id) ?? publicJob(job, attempt, await outputDirectories(job, environment))
    )));
    const metrics = await readGpuMetrics(metricsFile);
    return {
      jobs,
      counts,
      summary,
      pagination: { page, pageSize: query.pageSize, total, totalPages },
      workers: enrichWorkers(workers, activeJobs, metrics),
      paused: meta.paused === '1',
      manager_heartbeat: Number(meta.manager_heartbeat ?? 0),
      now,
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
    const source = await getLogSource(id, key);
    if (!source) return null;
    return { ...(await tail(source.path)), path: source.path };
  }

  async function getLogSource(id, key) {
    const row = jobQuery.get(id);
    if (!row) return null;
    const { job, environment } = decodeJob(row);
    const attempts = attemptsQuery.all(id);
    const directories = await outputDirectories(job, environment);
    const logs = await logSources(job, attempts, directories, environment);
    const source = logs.find((item) => item.key === key);
    if (!source) return null;
    return source;
  }

  async function getArtifacts(id) {
    const row = jobQuery.get(id);
    if (!row) return null;
    const { job, environment } = decodeJob(row);
    return artifactMetadata(job, environment);
  }

  return { listJobs, getJob, getLog, getLogSource, getArtifacts, close: () => database.close() };
}
