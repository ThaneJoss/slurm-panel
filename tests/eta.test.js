import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProgressEstimator, progressOf } from '../src/data/eta.js';
import { enrichJob } from '../src/data/query.js';
import { createGpuqStore } from '../src/data/gpuq.js';
import { createFixture } from './fixtures.js';

function sample(position, updated, overrides = {}) {
  return {
    id: 1, state: 'running', attempt: { number: 1, started: 1 },
    telemetry: { total_percent: position, total_epochs: 10, completed_epochs: position / 10, updated },
    ...overrides,
  };
}

test('dual progress uses completed batches within the current epoch and supports resumed global steps', () => {
  assert.deepEqual(progressOf({ epoch: 4, batch: 25, batches: 100 }, 10), {
    current_epoch: 4, completed_epochs: 3, epoch_percent: 25, total_percent: 32.5,
  });
  assert.deepEqual(progressOf({ current_epoch: 5, completed_epochs: 4, batch: 50, batches: 100 }, 10), {
    current_epoch: 5, completed_epochs: 4, epoch_percent: 50, total_percent: 45,
  });
  assert.equal(progressOf({ epoch: 4, batch: 25, batches: 100, updates: 325, total_updates: 1000 }, 10).total_percent, 32.5);
  assert.equal(progressOf({ epoch: 4 }, 10).total_percent, 40);
  assert.equal(progressOf({ epoch: 4 }, 10).epoch_percent, null);
  assert.equal(progressOf({ percent: 67 }, null).total_percent, 67);
  assert.equal(enrichJob({ argv: ['train.py', '--epochs', '10'], telemetry: { epoch: 4, batch: 25, batches: 100 } }).telemetry.total_percent, 32.5);
});

test('recency weighting reacts more strongly to the newer training interval and repeated reads do not add samples', () => {
  const estimator = createProgressEstimator({ halfLifeSeconds: 100 });
  estimator.observe(sample(10, 100));
  estimator.observe(sample(20, 200));
  const latest = sample(30, 250);
  estimator.observe(latest);
  estimator.observe(latest);
  const result = estimator.estimate(latest, 250);
  const weight = 2 ** -0.5;
  const expected = 70 * (100 * weight + 50) / (10 * weight + 10);
  assert.ok(Math.abs(result.remaining_seconds - expected) < 1e-9);
  assert.ok(result.remaining_seconds < 70 * 150 / 20);
  assert.equal(result.end_at, result.remaining_seconds + 250);
  assert.equal(result.sample_count, 3);
  assert.equal(result.method, 'recency_weighted');
  assert.equal(result.scope, 'training_and_periodic_validation');
});

test('periodic validation gaps contribute elapsed time, while an explicit final estimate defines whole-task scope', () => {
  const estimator = createProgressEstimator();
  estimator.observe(sample(10, 100));
  estimator.observe(sample(20, 200));
  estimator.observe(sample(20, 250, { telemetry: { total_percent: 20, total_epochs: 10, completed_epochs: 2, phase: 'validation', updated: 250 } }));
  const latest = sample(30, 350, { telemetry: { total_percent: 30, total_epochs: 10, completed_epochs: 3, final_evaluation_seconds: 120, updated: 350 } });
  estimator.observe(latest);
  const result = estimator.estimate(latest, 350);
  assert.ok(result.remaining_seconds > 700 + 120);
  assert.equal(result.scope, 'full_task');
  assert.equal(result.sample_count, 3);
  const next = estimator.estimate(latest, 380);
  assert.equal(next.end_at, result.end_at);
  assert.equal(next.remaining_seconds, result.remaining_seconds - 30);
});

test('unknown progress, one sample, budget clocks, terminal jobs and changed attempts do not produce fabricated ETA', () => {
  const estimator = createProgressEstimator();
  const first = sample(10, 100);
  estimator.observe(first);
  assert.equal(estimator.estimate(first), null);
  const budget = sample(30, 200, { id: 2, telemetry: { total_percent: 30, total_epochs: 10, completed_epochs: null, percent_kind: 'budget', updated: 200 } });
  estimator.observe(budget);
  estimator.observe({ ...budget, telemetry: { ...budget.telemetry, total_percent: 40, updated: 300 } });
  assert.equal(estimator.estimate(budget), null);
  estimator.observe(sample(20, 200));
  assert.equal(estimator.estimate({ ...first, state: 'succeeded' }), null);
  const retried = sample(10, 300, { attempt: { number: 2, started: 250 } });
  estimator.observe(retried);
  assert.equal(estimator.estimate(retried), null);
  estimator.observe(sample(20, 400, { attempt: retried.attempt }));
  assert.equal(estimator.estimate(retried, 400).sample_count, 2);
});

test('background sampling bootstraps timestamped log history and restores independent panel state after restart', async (t) => {
  const fixture = await createFixture(t);
  fixture.job({ argv: ['node', 'train.mjs', '--epochs', '10'] });
  const attempt = fixture.attempt();
  fixture.finish();
  await writeFile(attempt.log_path, [
    { phase: 'training', epoch: 3, batch: 50, batches: 100, step: 250, planned_steps: 1000, timestamp: fixture.now - 120 },
    { phase: 'training', epoch: 4, batch: 50, batches: 100, step: 350, planned_steps: 1000, timestamp: fixture.now - 60 },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const etaStateFile = join(fixture.directory, 'panel-state', 'eta.json');
  const store = createGpuqStore({ databasePath: fixture.databasePath, etaStateFile });
  await store.sampleProgress();
  const first = await store.getJob(1);
  assert.equal(first.telemetry.epoch_percent, 50);
  assert.equal(first.telemetry.total_percent, 35);
  assert.equal(first.estimate.sample_count, 2);
  assert.ok(Math.abs(first.estimate.end_at - (fixture.now - 60 + 390)) < 1e-6);
  const saved = JSON.parse(await readFile(etaStateFile, 'utf8'));
  assert.equal(saved.histories.length, 1);
  assert.equal(JSON.stringify(saved).includes(attempt.log_path), false);
  store.close();

  // No browser request or original log is needed to preserve the learned rate.
  await rm(attempt.log_path);
  const restarted = createGpuqStore({ databasePath: fixture.databasePath, etaStateFile });
  t.after(() => restarted.close());
  const restored = await restarted.getJob(1);
  assert.equal(restored.estimate.end_at, first.estimate.end_at);
  assert.equal(restored.estimate.sample_count, 2);
});

test('preparation time is excluded from the first training speed interval', () => {
  const estimator = createProgressEstimator();
  estimator.observe(sample(0, 100, { telemetry: { total_percent: 0, total_epochs: 10, completed_epochs: 0, phase: 'loading_data', updated: 100 } }));
  const first = sample(5, 400, { telemetry: { total_percent: 5, total_epochs: 10, completed_epochs: 0.5, phase: 'training', updated: 400 } });
  estimator.observe(first);
  assert.equal(estimator.estimate(first, 400), null);
  const next = sample(10, 450);
  estimator.observe(next);
  assert.equal(estimator.estimate(next, 450).remaining_seconds, 900);
  assert.equal(estimator.estimate(next, 450).sample_count, 2);
});

test('explicit target changes reset speed once and older log replay cannot replace the newer target', () => {
  const estimator = createProgressEstimator();
  function prepare(telemetry, attempt = { number: 1, started: 1 }) {
    return enrichJob(estimator.prepare({ id: 1, state: 'running', argv: ['train.py', '--epochs', '120'], attempt, telemetry }));
  }
  estimator.observe(prepare({ epoch: 12, updated: 50 }));
  estimator.observe(prepare({ updates: 10, total_updates: 100, updated: 100 }));
  estimator.observe(prepare({ updates: 20, updated: 200 }));
  assert.equal(estimator.estimate(prepare({ updates: 20, updated: 200 }), 200).sample_count, 2);
  const changed = prepare({ updates: 30, total_updates: 200, updated: 300 });
  estimator.observe(changed);
  assert.equal(estimator.estimate(changed, 300), null);
  const replayed = prepare({ updates: 10, total_updates: 100, updated: 100 });
  estimator.observe(replayed);
  assert.equal(replayed.telemetry.total_updates, 200);
  assert.equal(estimator.estimate(changed, 300), null);
  const next = prepare({ updates: 40, updated: 400 });
  estimator.observe(next);
  assert.equal(next.telemetry.total_percent, 20);
  assert.equal(estimator.estimate(next, 400).sample_count, 2);
  const retry = prepare({ updates: 40, updated: 500 }, { number: 2, started: 450 });
  assert.equal(retry.telemetry.total_updates, null);
  assert.equal(retry.telemetry.total_percent, null);
  assert.equal(estimator.estimate(retry, 500), null);
});

test('mixed epoch summaries inherit the actual update target across reads, final evaluation and restart', async (t) => {
  const fixture = await createFixture(t);
  fixture.job({ argv: ['node', 'train.mjs', '--epochs', '120', '--resume-to-epochs', '100'] });
  const attempt = fixture.attempt({ started: fixture.now - 1000 });
  fixture.finish();
  const rows = [
    { state: 'training', epoch: 40, batch: 121, batches: 132, step: 5269, planned_steps: 13200, timestamp: fixture.now - 900 },
    { epoch: 40, step: 5280, timestamp: fixture.now - 800 },
    { state: 'training', epoch: 41, batch: 1, batches: 132, step: 5281, planned_steps: 13200, timestamp: fixture.now - 700 },
    { epoch: 41, step: 5412, timestamp: fixture.now - 600 },
  ];
  await writeFile(attempt.log_path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const etaStateFile = join(fixture.directory, 'eta-targets.json');
  const store = createGpuqStore({ databasePath: fixture.databasePath, etaStateFile });
  await store.sampleProgress();
  const job = await store.getJob(1);
  assert.equal(job.telemetry.total_updates, 13200);
  assert.equal(job.telemetry.total_epochs, 120);
  assert.equal(job.telemetry.total_percent, 41);
  assert.equal(job.estimate.sample_count, 4);
  assert.equal((await store.getJob(1)).estimate.sample_count, 4);
  const saved = JSON.parse(await readFile(etaStateFile, 'utf8'));
  assert.equal(saved.histories[0][1].metadata.total_updates, 13200);
  store.close();

  await writeFile(attempt.log_path, JSON.stringify({ state: 'final_evaluation', epoch: 100, step: 13200, timestamp: fixture.now - 10 }) + '\n');
  const restarted = createGpuqStore({ databasePath: fixture.databasePath, etaStateFile });
  t.after(() => restarted.close());
  const final = await restarted.getJob(1);
  assert.equal(final.telemetry.total_updates, 13200);
  assert.equal(final.telemetry.total_percent, 100);
  assert.equal(final.telemetry.phase, 'final_evaluation');
  assert.equal(final.state, 'running');
  assert.equal(final.estimate.scope, 'training_and_periodic_validation');
});
