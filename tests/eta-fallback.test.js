import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { progressOf, createProgressEstimator } from '../src/data/eta.js';
import { enrichJob } from '../src/data/query.js';
import { createGpuqStore } from '../src/data/gpuq.js';
import { createFixture } from './fixtures.js';

test('missing current updates fall back to epoch progress while complete update pairs stay preferred', () => {
  const telemetry = { epoch: 4, total_updates: 1000 };
  for (const updates of [undefined, null, '', -1]) {
    const progress = progressOf({ ...telemetry, updates }, 10);
    assert.equal(progress.completed_epochs, 4);
    assert.equal(progress.total_percent, 40);
  }
  assert.equal(progressOf({ ...telemetry, batch: 25, batches: 100 }, 10).total_percent, 32.5);
  assert.equal(progressOf({ ...telemetry, updates: 325 }, 10).total_percent, 32.5);
  assert.equal(progressOf({ ...telemetry, updates: 0 }, 10).total_percent, 0);
  assert.equal(progressOf({ total_updates: 1000, percent: 67 }, null).total_percent, 67);
});

test('inherited update targets do not suppress epoch-only log summaries or freeze ETA', async (t) => {
  const fixture = await createFixture(t);
  fixture.job({ argv: ['node', 'train.mjs', '--epochs', '10'] });
  const attempt = fixture.attempt({ started: fixture.now - 1000 });
  fixture.finish();
  const rows = [
    { phase: 'training', epoch: 1, step: 100, planned_steps: 1000, timestamp: fixture.now - 300 },
    { phase: 'training', epoch: 2, timestamp: fixture.now - 200 },
  ];
  const writeRows = () => writeFile(attempt.log_path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await writeRows();
  const store = createGpuqStore({ databasePath: fixture.databasePath });
  t.after(() => store.close());
  await store.sampleProgress();
  const first = await store.getJob(1);
  assert.equal(first.telemetry.total_updates, 1000);
  assert.equal(first.telemetry.updates, null);
  assert.equal(first.telemetry.completed_epochs, 2);
  assert.equal(first.telemetry.total_percent, first.telemetry.completed_epochs / first.telemetry.total_epochs * 100);
  assert.equal(first.estimate.sample_count, 2);
  assert.equal(first.estimate.updated, fixture.now - 200);
  assert.equal(first.estimate.end_at, fixture.now + 600);

  rows.push({ phase: 'training', epoch: 3, timestamp: fixture.now - 100 });
  await writeRows();
  await store.sampleProgress();
  const latest = await store.getJob(1);
  assert.equal(latest.telemetry.total_updates, 1000);
  assert.equal(latest.telemetry.updates, null);
  assert.equal(latest.telemetry.total_percent, 30);
  assert.equal(latest.estimate.sample_count, 3);
  assert.equal(latest.estimate.updated, fixture.now - 100);
  assert.equal(latest.estimate.end_at, fixture.now + 600);
  assert.equal((await store.getJob(1)).estimate.sample_count, 3);
});

test('reported percentages remain eligible without current updates while budget clocks stay excluded', () => {
  for (const kind of ['reported', 'budget']) {
    const estimator = createProgressEstimator();
    let latest;
    for (const [percent, updated] of [[10, 100], [20, 200]]) {
      latest = enrichJob(estimator.prepare({
        id: 1, state: 'running', argv: [], attempt: { number: 1, started: 1 },
        telemetry: { total_updates: 1000, percent, percent_kind: kind, updated },
      }));
      assert.equal(latest.telemetry.total_percent, percent);
      estimator.observe(latest);
    }
    const estimate = estimator.estimate(latest, 200);
    if (kind === 'reported') {
      assert.equal(estimate.sample_count, 2);
      assert.equal(estimate.remaining_seconds, 800);
    } else assert.equal(estimate, null);
  }
});
