const ACTIVE_STATES = new Set(['assigned', 'launching', 'starting', 'running']);
const PREPARATION_PHASES = new Set(['initializing', 'initialization', 'loading_data', 'loading_model', 'preparing', 'setup', 'resume']);

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function boundedPercent(value) {
  return value === null ? null : Math.min(100, Math.max(0, value));
}

/** Legacy batch records use a one-based current epoch; epoch-only records report completed epochs. */
export function progressOf(telemetry, totalEpochs = null) {
  const batch = number(telemetry.batch);
  const batches = number(telemetry.batches);
  const fraction = batch !== null && batches > 0 ? Math.min(1, batch / batches) : null;
  const epoch = number(telemetry.epoch);
  const explicitCompleted = number(telemetry.completed_epochs);
  const explicitCurrent = number(telemetry.current_epoch);
  const currentEpoch = explicitCurrent ?? (fraction !== null && epoch !== null ? epoch : null);
  const completedEpochs = explicitCompleted
    ?? (currentEpoch !== null ? Math.max(0, currentEpoch - 1) : epoch);
  const epochPosition = completedEpochs === null ? null : completedEpochs + (fraction ?? 0);
  const updates = number(telemetry.updates);
  const totalUpdates = number(telemetry.total_updates);
  const explicitPercent = number(telemetry.percent);
  const epochPercent = fraction === null ? null : fraction * 100;
  const totalPercent = totalUpdates > 0 && updates !== null ? updates / totalUpdates * 100
    : epochPosition !== null && totalEpochs > 0 ? epochPosition / totalEpochs * 100
      : explicitPercent;
  return {
    current_epoch: currentEpoch,
    completed_epochs: completedEpochs,
    epoch_percent: boundedPercent(epochPercent),
    total_percent: boundedPercent(totalPercent),
  };
}

/** A time-decayed weighted mean of interval duration/work, isolated by attempt. */
export function createProgressEstimator({ halfLifeSeconds = 300, state = [] } = {}) {
  const histories = new Map(state);

  function historyFor(job) {
    if (!job.attempt) return null;
    const key = `${job.id}:${job.attempt.number}`;
    let history = histories.get(job.id);
    if (!history || history.key !== key) {
      history = { key, samples: [], intervals: [], metadata: {}, metadata_updated: null };
      histories.set(job.id, history);
    }
    return history;
  }

  /** Fill omitted target metadata before computing percentages; argv fallbacks never become recorded targets. */
  function prepare(job) {
    if (!job.telemetry) return job;
    const history = historyFor(job);
    if (!history) return job;
    const metadata = history.metadata ??= {};
    const updated = number(job.telemetry.updated);
    if (updated !== null && (history.metadata_updated == null || updated >= history.metadata_updated)) {
      const targets = {};
      for (const key of ['total_updates', 'total_epochs']) {
        const value = number(job.telemetry[key]);
        if (value > 0) targets[key] = value;
      }
      const targetChanged = Object.entries(targets).some(([key, value]) => metadata[key] !== value);
      if (targetChanged) {
        history.samples = [];
        history.intervals = [];
        history.target_updated = updated;
      }
      Object.assign(metadata, targets);
      const finalSeconds = number(job.telemetry.final_evaluation_seconds);
      if (finalSeconds !== null) metadata.final_evaluation_seconds = finalSeconds;
      history.metadata_updated = updated;
    }
    return {
      ...job,
      telemetry: {
        ...job.telemetry,
        total_updates: metadata.total_updates ?? job.telemetry.total_updates ?? null,
        total_epochs: metadata.total_epochs ?? job.telemetry.total_epochs ?? null,
        final_evaluation_seconds: metadata.final_evaluation_seconds ?? job.telemetry.final_evaluation_seconds ?? null,
      },
    };
  }

  function observe(job) {
    if (!ACTIVE_STATES.has(job.state)) return;
    const telemetry = job.telemetry;
    if (PREPARATION_PHASES.has(telemetry?.phase)) return;
    const updated = number(telemetry?.updated);
    const position = number(telemetry?.total_percent);
    const started = number(job.attempt?.started);
    // Budget percentages measure elapsed allocation, not completed work.
    const hasWork = (number(telemetry?.total_updates) > 0 && number(telemetry?.updates) !== null)
      || (number(telemetry?.total_epochs) > 0 && number(telemetry?.completed_epochs) !== null)
      || telemetry?.percent_kind === 'reported';
    if (!telemetry || updated === null || position === null || !hasWork
      || started === null || updated < started) return;
    const history = historyFor(job);
    if (history.target_updated != null && updated < history.target_updated) return;
    const previous = history.samples.at(-1);
    if (previous && updated <= previous.updated) return;
    if (previous && position < previous.position) {
      history.samples = [];
      history.intervals = [];
    }
    const anchor = history.samples.at(-1);
    if (anchor && position === anchor.position) return;
    const sample = { updated, position };
    if (anchor) history.intervals.push({
      updated,
      seconds: updated - anchor.updated,
      work: position - anchor.position,
    });
    history.samples.push(sample);
    // Bound memory while retaining substantially more than one decay window.
    history.samples = history.samples.slice(-256);
    history.intervals = history.intervals.slice(-255);
  }

  function estimate(job, now = Date.now() / 1000) {
    const history = histories.get(job.id);
    if (!ACTIVE_STATES.has(job.state) || !history
      || history.key !== `${job.id}:${job.attempt?.number}` || history.intervals.length === 0) return null;
    const latest = history.samples.at(-1);
    let weightedSeconds = 0;
    let weightedWork = 0;
    for (const interval of history.intervals) {
      const weight = 2 ** (-(latest.updated - interval.updated) / halfLifeSeconds);
      weightedSeconds += interval.seconds * weight;
      weightedWork += interval.work * weight;
    }
    const secondsPerPercent = weightedSeconds / weightedWork;
    const finalSeconds = number(job.telemetry?.final_evaluation_seconds);
    const remainingTrain = Math.max(0, (100 - latest.position) * secondsPerPercent);
    const projectedEnd = latest.updated + remainingTrain + (finalSeconds ?? 0);
    return {
      remaining_seconds: Math.max(0, projectedEnd - now),
      end_at: projectedEnd,
      scope: finalSeconds === null ? 'training_and_periodic_validation' : 'full_task',
      method: 'recency_weighted',
      sample_count: history.samples.length,
      updated: latest.updated,
    };
  }

  function retain(jobIds) {
    const active = new Set(jobIds);
    for (const id of histories.keys()) {
      if (!active.has(id)) histories.delete(id);
    }
  }

  return { prepare, observe, estimate, retain, snapshot: () => [...histories] };
}
