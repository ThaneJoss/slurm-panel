import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, enrichJob, selectJobs, enrichWorkers } from '../src/data/query.js';

test('query validates parameters and supports URL and internal object inputs', () => {
  assert.deepEqual(parseQuery(new URLSearchParams('page=2&pageSize=20&q=trial&state=failed&sort=oldest&range=7d&staleOnly=1')), {
    page: 2, pageSize: 20, q: 'trial', state: 'failed', sort: 'oldest', range: '7d', staleOnly: true,
  });
  assert.equal(parseQuery({ staleOnly: true }).staleOnly, true);
  for (const input of [
    { page: '-1' }, { page: '1.2' }, { pageSize: '101' }, { state: 'all OR 1=1' },
    { sort: 'created;delete' }, { range: 'forever' }, { staleOnly: 'yes' }, { q: [] },
  ]) {
    assert.throws(() => parseQuery(input), (error) => error.statusCode === 400);
  }
});

test('display progress respects script budget percentages and ETA without inferring completion', () => {
  const job = {
    id: 1, state: 'running', argv: ['node', 'train.mjs', '--seed=44', '--stride', '1', '--epochs', '90'],
    attempt: { started: 1000 }, telemetry: { epoch: 48, percent: 30, updated: 1700, eta_seconds: 3600 },
  };
  const enriched = enrichJob(job, 2000);
  assert.deepEqual(enriched.tags, ['stride 1', 'seed 44', '90 epochs']);
  assert.equal(enriched.telemetry.percent, 30);
  assert.equal(enriched.telemetry.percent_kind, 'budget');
  assert.equal(enriched.telemetry.total_epochs, 90);
  assert.equal(enriched.telemetry.eta_seconds, 3600);
  assert.equal(enriched.stale, false);
  assert.equal(enriched.stale_seconds, 300);
  assert.equal(job.telemetry.total_epochs, undefined);

  const epochs = enrichJob({ ...job, telemetry: { epoch: 45, updated: 1200 } }, 2000);
  assert.equal(epochs.telemetry.percent, 50);
  assert.equal(epochs.telemetry.percent_kind, 'epoch');
  assert.equal(epochs.telemetry.eta_seconds, null);
  assert.equal(epochs.stale, true);
  assert.equal(enrichJob({ ...job, state: 'succeeded' }, 10000).stale, false);
  assert.equal(enrichJob({ ...job, state: 'starting' }, 10000).stale, false);
});

test('history filtering and pagination retain global range counts and do not truncate old jobs', () => {
  const now = 200000;
  const jobs = Array.from({ length: 250 }, (_, index) => ({
    id: index + 1, name: index === 0 ? 'Unique old experiment' : `Experiment ${index + 1}`,
    state: index === 0 ? 'running' : index === 1 ? 'cancelled' : 'succeeded',
    created: index === 249 ? now - 90000 : now - 100,
    stale: index === 0,
  }));
  const found = selectJobs(jobs, { q: 'unique OLD', pageSize: 1 }, now);
  assert.equal(found.jobs[0].id, 1);
  assert.equal(found.summary.total, 250);
  assert.equal(found.summary.active, 1);
  assert.equal(found.summary.cancelled, 1);
  assert.equal(found.summary.stale, 1);
  assert.deepEqual(found.pagination, { page: 1, pageSize: 1, total: 1, totalPages: 1 });

  const history = selectJobs(jobs, { range: '24h', state: 'succeeded', page: 999, pageSize: 100, sort: 'oldest' }, now);
  assert.equal(history.summary.total, 249);
  assert.equal(history.pagination.page, 3);
  assert.equal(history.pagination.total, 247);
  assert.equal(history.jobs[0].id, 203);
  assert.equal(history.jobs.at(-1).id, 249);
  const failed = selectJobs(jobs, { state: 'failed' }, now);
  assert.deepEqual(failed.jobs, []);
  assert.deepEqual(failed.pagination, { page: 1, pageSize: 10, total: 0, totalPages: 1 });
});

test('running priority, queued group and stale-only filters preserve recorded lifecycle states', () => {
  const jobs = [
    { id: 1, name: 'active', state: 'starting', created: 100, stale: false },
    { id: 2, name: 'wait', state: 'waiting_resources', created: 100, stale: false },
    { id: 3, name: 'done', state: 'succeeded', created: 100, stale: false },
    { id: 4, name: 'old heartbeat', state: 'running', created: 100, stale: true },
  ];
  assert.deepEqual(selectJobs(jobs).jobs.map((job) => job.id), [4, 1, 3, 2]);
  assert.deepEqual(selectJobs(jobs, { state: 'queued' }).jobs.map((job) => job.id), [2]);
  const stale = selectJobs(jobs, { staleOnly: true });
  assert.equal(stale.jobs.length, 1);
  assert.equal(stale.jobs[0].state, 'running');
});

test('workers use all active tasks and distinguish missing telemetry from actual zero readings', () => {
  const workers = [{ gpu: 0, heartbeat: 100 }, { gpu: 1, heartbeat: 100 }, { gpu: 2, heartbeat: null }];
  const jobs = [
    { id: 1, state: 'running', attempt: { gpu: 0 } },
    { id: 250, state: 'starting', attempt: { gpu: 0 } },
    { id: 3, state: 'succeeded', attempt: { gpu: 1 } },
  ];
  const result = enrichWorkers(workers, jobs, [{
    gpu: 0, utilization_percent: 0, memory_used_bytes: 0, memory_total_bytes: 24 * 1024 ** 3, updated: 100,
  }, { gpu: 1, utilization_percent: 101 }]);
  assert.deepEqual(result[0].job_ids, [250, 1]);
  assert.equal(result[0].state, 'running');
  assert.equal(result[0].metrics.utilization_percent, 0);
  assert.equal(result[0].metrics.memory_used_bytes, 0);
  assert.equal(result[1].state, 'idle');
  assert.equal(result[1].metrics, null);
  assert.equal(result[2].state, 'unknown');
  assert.equal(result[2].metrics, null);
});
