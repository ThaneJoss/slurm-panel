import { progressOf } from './eta.js';

const ACTIVE_STATES = new Set(['assigned', 'launching', 'starting', 'running']);
const QUEUED_STATES = new Set(['queued', 'waiting_resources']);
const QUERY_STATES = new Set(['all', 'active', 'queued', 'succeeded', 'failed', 'cancelled']);
const QUERY_SORTS = new Set(['active', 'newest', 'oldest']);
const RANGE_SECONDS = new Map([['24h', 86400], ['7d', 604800], ['30d', 2592000]]);

function invalidQuery(name) {
  const error = new Error(`Invalid query parameter: ${name}`);
  error.statusCode = 400;
  return error;
}

function integer(value, name, defaultValue, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (!/^\d+$/.test(String(value))) throw invalidQuery(name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw invalidQuery(name);
  return parsed;
}

function choice(value, name, allowed, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (!allowed.has(value)) throw invalidQuery(name);
  return value;
}

/** Normalize request query parameters before any database or file reads. */
export function parseQuery(input = {}) {
  const read = (key) => input instanceof URLSearchParams ? input.get(key) : input[key];
  const staleOnly = read('staleOnly');
  if (![undefined, null, '', '0', '1', false, true].includes(staleOnly)) throw invalidQuery('staleOnly');
  const q = read('q') ?? '';
  if (typeof q !== 'string') throw invalidQuery('q');
  return {
    page: integer(read('page'), 'page', 1),
    pageSize: integer(read('pageSize'), 'pageSize', 10, 100),
    q: q.trim(),
    state: choice(read('state'), 'state', QUERY_STATES, 'all'),
    sort: choice(read('sort'), 'sort', QUERY_SORTS, 'active'),
    range: choice(read('range'), 'range', new Set(['all', ...RANGE_SECONDS.keys()]), 'all'),
    staleOnly: staleOnly === '1' || staleOnly === true,
  };
}

function finiteNumber(value, minimum = 0) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : null;
}

function argumentsByName(argv = []) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== 'string' || !argument.startsWith('--')) continue;
    const equals = argument.indexOf('=');
    if (equals >= 0) {
      values.set(argument.slice(0, equals), argument.slice(equals + 1));
    } else if (typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--')) {
      values.set(argument, argv[index + 1]);
    }
  }
  return values;
}

/** Add display metadata without changing the queue's recorded lifecycle state. */
export function enrichJob(job, now = Date.now() / 1000) {
  const argumentsMap = argumentsByName(job.argv);
  const epochArgument = ['--epochs', '--max-epochs', '--num-epochs']
    .map((flag) => argumentsMap.get(flag)).find((value) => value !== undefined);
  const totalEpochs = finiteNumber(job.telemetry?.total_epochs, Number.MIN_VALUE)
    ?? finiteNumber(epochArgument, Number.MIN_VALUE);
  const tags = [];
  if (argumentsMap.has('--stride')) tags.push(`stride ${argumentsMap.get('--stride')}`);
  if (argumentsMap.has('--seed')) tags.push(`seed ${argumentsMap.get('--seed')}`);
  if (totalEpochs !== null) tags.push(`${totalEpochs} epochs`);

  let telemetry = null;
  if (job.telemetry) {
    const percent = finiteNumber(job.telemetry.percent);
    const epoch = finiteNumber(job.telemetry.epoch);
    const hasEpochProgress = totalEpochs !== null && epoch !== null;
    telemetry = {
      ...job.telemetry,
      total_epochs: totalEpochs,
      eta_seconds: finiteNumber(job.telemetry.eta_seconds),
      percent: percent ?? (hasEpochProgress ? Math.min(100, epoch / totalEpochs * 100) : null),
      percent_kind: job.telemetry.percent_kind
        ?? (percent !== null ? 'budget' : hasEpochProgress ? 'epoch' : null),
      ...progressOf(job.telemetry, totalEpochs),
    };
  }

  const started = finiteNumber(job.attempt?.started);
  const progressUpdated = finiteNumber(telemetry?.updated) ?? started;
  const staleSeconds = job.state === 'running' && started !== null && progressUpdated !== null
    ? Math.max(0, now - progressUpdated)
    : null;
  return {
    ...job,
    telemetry,
    tags,
    stale: staleSeconds !== null && staleSeconds > 600,
    stale_seconds: staleSeconds,
  };
}

function matchesState(job, state) {
  if (state === 'all') return true;
  if (state === 'active') return ACTIVE_STATES.has(job.state);
  if (state === 'queued') return QUEUED_STATES.has(job.state);
  return job.state === state;
}

/** Select the requested page while retaining time-range totals for status cards. */
export function selectJobs(jobs, input = {}, now = Date.now() / 1000) {
  const options = parseQuery(input);
  const age = RANGE_SECONDS.get(options.range);
  const history = age === undefined ? jobs : jobs.filter((job) => job.created >= now - age);
  const grouped = new Map();
  const summary = { total: history.length, active: 0, queued: 0, succeeded: 0, failed: 0, cancelled: 0, stale: 0 };
  for (const job of history) {
    grouped.set(job.state, (grouped.get(job.state) ?? 0) + 1);
    if (ACTIVE_STATES.has(job.state)) summary.active += 1;
    if (QUEUED_STATES.has(job.state)) summary.queued += 1;
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) summary[job.state] += 1;
    if (job.stale) summary.stale += 1;
  }
  const query = options.q.toLocaleLowerCase();
  const matches = history.filter((job) => (
    matchesState(job, options.state)
    && (!options.staleOnly || job.stale)
    && (!query || String(job.name).toLocaleLowerCase().includes(query) || String(job.id).includes(query))
  ));
  matches.sort((left, right) => {
    if (options.sort === 'active') {
      const priority = Number(ACTIVE_STATES.has(right.state)) - Number(ACTIVE_STATES.has(left.state));
      if (priority !== 0) return priority;
    }
    return options.sort === 'oldest' ? left.id - right.id : right.id - left.id;
  });
  const totalPages = Math.max(1, Math.ceil(matches.length / options.pageSize));
  const page = Math.min(options.page, totalPages);
  return {
    jobs: matches.slice((page - 1) * options.pageSize, page * options.pageSize),
    counts: Object.fromEntries(grouped),
    summary,
    pagination: { page, pageSize: options.pageSize, total: matches.length, totalPages },
  };
}

function projectMetrics(record, now) {
  if (!record || !Number.isFinite(record.updated) || now - record.updated > 30) return null;
  let utilization = finiteNumber(record.utilization_percent);
  if (utilization !== null && utilization > 100) utilization = null;
  const memoryTotal = finiteNumber(record.memory_total_bytes);
  let memoryUsed = finiteNumber(record.memory_used_bytes);
  if (memoryTotal !== null && memoryUsed !== null && memoryUsed > memoryTotal) memoryUsed = null;
  const average = finiteNumber(record.utilization_5m_percent);
  const processes = Array.isArray(record.processes) ? record.processes.map((process) => ({
    pid: process.pid, user: process.user, name: process.name,
    type: process.type, memory_used_bytes: finiteNumber(process.memory_used_bytes),
  })) : null;
  if (utilization === null && memoryTotal === null && memoryUsed === null && processes === null) return null;
  return {
    utilization_percent: utilization,
    utilization_5m_percent: average !== null && average <= 100 ? average : null,
    utilization_window_seconds: finiteNumber(record.utilization_window_seconds),
    memory_used_bytes: memoryUsed,
    memory_total_bytes: memoryTotal,
    processes,
    process_count: processes?.length ?? null,
    updated: finiteNumber(record.updated),
  };
}

/** Worker assignments always use all active jobs, independently of list paging. */
export function enrichWorkers(workers, allJobs, metrics = [], now = Date.now() / 1000) {
  const metricRecords = new Map(metrics.map((record) => [record.gpu, record]));
  const allWorkers = new Map(workers.map((worker) => [worker.gpu, worker]));
  for (const record of metrics) {
    if (!allWorkers.has(record.gpu)) allWorkers.set(record.gpu, { gpu: record.gpu, slurm_job_id: null, heartbeat: null });
  }
  return [...allWorkers.values()].sort((left, right) => left.gpu - right.gpu).map((worker) => {
    const jobIds = allJobs
      .filter((job) => ACTIVE_STATES.has(job.state) && job.attempt?.gpu === worker.gpu)
      .map((job) => job.id)
      .sort((left, right) => right - left);
    const current = projectMetrics(metricRecords.get(worker.gpu), now);
    const occupied = current && (current.process_count > 0 || current.utilization_percent > 0);
    return {
      ...worker,
      job_ids: jobIds,
      state: occupied ? 'running' : current?.process_count === 0 ? 'idle' : 'unknown',
      metrics: current,
    };
  });
}
