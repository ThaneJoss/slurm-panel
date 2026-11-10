import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createGpuqStore } from '../src/data/gpuq.js';
import { createFixture, writeAt } from './fixtures.js';

test('old retry progress files cannot hide fresh untimestamped attempt logs', async (t) => {
  const fixture = await createFixture(t);
  const now = Math.floor(fixture.now);
  fixture.job({ attempt_count: 2 });
  fixture.attempt({
    number: 1, state: 'oom', created: now - 2100,
    started: now - 2000, finished: now - 900,
  });
  const attempt = fixture.attempt({
    number: 2, created: now - 120, started: now - 100,
    log_path: join(fixture.directory, 'attempt-2.log'),
  });
  fixture.finish();

  for (const filename of ['status.json', 'progress.json']) {
    await writeAt(join(fixture.cwd, filename), JSON.stringify({
      phase: 'training', epoch: 9, total_epochs: 10,
      queue: { GPUQ_JOB_ID: '1' },
    }), now - 1000);
  }
  await writeAt(attempt.log_path,
    '{"phase":"training","epoch":1,"total_epochs":10}\n', now);
  const store = createGpuqStore(fixture);
  t.after(() => store.close());
  const first = await store.getJob(1);
  assert.equal(first.attempt.number, 2);
  assert.equal(first.telemetry.source, attempt.log_path);
  assert.equal(first.telemetry.updated_source, 'observed');
  assert.equal(first.telemetry.total_percent, 10);
  assert.equal(first.stale, false);

  await writeAt(attempt.log_path,
    '{"phase":"training","epoch":2,"total_epochs":10}\n', now);
  const next = await store.getJob(1);
  assert.equal(next.telemetry.source, attempt.log_path);
  assert.equal(next.telemetry.total_percent, 20);
  assert.equal(next.stale, false);
});

for (const pending of [false, true]) {
  test(`progress files use attempt ${pending ? 'creation before startup' : 'start after creation'} as their boundary`, async (t) => {
    const fixture = await createFixture(t);
    const now = Math.floor(fixture.now);
    const boundary = now - 100;
    fixture.job({ state: pending ? 'starting' : 'running', attempt_count: 2 });
    fixture.attempt({
      number: 2,
      state: pending ? 'starting' : 'running',
      created: pending ? boundary : now - 200,
      started: pending ? null : boundary,
      log_path: join(fixture.directory, 'attempt-2.log'),
    });
    fixture.finish();
    const path = join(fixture.cwd, 'progress.json');
    await writeAt(path, '{"epoch":9,"total_epochs":10}', now - 150);
    const store = createGpuqStore(fixture);
    t.after(() => store.close());
    const old = await store.getJob(1);
    assert.equal(old.telemetry, null);
    assert.equal(old.estimate, null);
    assert.equal(old.stale, false);

    // Integer seconds make the inclusive filesystem timestamp boundary exact.
    await writeAt(path, '{"epoch":4,"total_epochs":10}', boundary);
    const current = await store.getJob(1);
    assert.equal(current.telemetry.source, path);
    assert.equal(current.telemetry.updated, boundary);
    assert.equal(current.telemetry.total_percent, 40);
    assert.equal(current.estimate, null);
    assert.equal(current.stale, false);
  });
}

test('jobs without an attempt retain the job creation progress boundary', async (t) => {
  const fixture = await createFixture(t);
  const created = Math.floor(fixture.now) - 3600;
  fixture.job({ state: 'queued', created });
  fixture.finish();
  const path = join(fixture.cwd, 'status.json');
  await writeAt(path, '{"epoch":2,"total_epochs":10}', created - 1);
  const store = createGpuqStore(fixture);
  t.after(() => store.close());
  assert.equal((await store.getJob(1)).telemetry, null);
  await writeAt(path, '{"epoch":2,"total_epochs":10}', created);
  const job = await store.getJob(1);
  assert.equal(job.attempt, null);
  assert.equal(job.telemetry.source, path);
  assert.equal(job.telemetry.updated, created);
  assert.equal(job.telemetry.total_percent, 20);
  assert.equal(job.estimate, null);
});

test('fresh log mtime cannot turn an earlier attempt timestamp into current progress', async (t) => {
  const fixture = await createFixture(t);
  const now = Math.floor(fixture.now);
  fixture.job({ attempt_count: 2 });
  const attempt = fixture.attempt({
    number: 2, created: now - 120, started: now - 100,
    log_path: join(fixture.directory, 'attempt-2.log'),
  });
  fixture.finish();
  await writeAt(attempt.log_path, JSON.stringify({
    phase: 'training', epoch: 9, total_epochs: 10, timestamp: now - 150,
  }) + '\nnormal output after retry\n', now);
  const store = createGpuqStore(fixture);
  t.after(() => store.close());
  const job = await store.getJob(1);
  assert.equal(job.telemetry, null);
  assert.equal(job.estimate, null);
  assert.equal(job.stale, false);
});

test('resumed progress keeps nonzero work while old timestamped rows cannot seed targets or replace it', async (t) => {
  const fixture = await createFixture(t);
  const now = Math.floor(fixture.now);
  fixture.job({ attempt_count: 2, argv: ['train.py'] });
  const attempt = fixture.attempt({
    number: 2, created: now - 120, started: now - 100,
    log_path: join(fixture.directory, 'attempt-2.log'),
  });
  fixture.finish();
  const records = [
    { phase: 'training', step: 1900, planned_steps: 2000, total_epochs: 200, timestamp: now - 150 },
    { phase: 'training', step: 600, planned_steps: 1000, timestamp: now - 80 },
    { phase: 'training', step: 650, timestamp: now - 60 },
    { phase: 'training', step: 1950, planned_steps: 2000, total_epochs: 200, timestamp: now - 110 },
  ];
  await writeAt(attempt.log_path, records.map((record) => JSON.stringify(record)).join('\n') + '\n', now);
  const store = createGpuqStore(fixture);
  t.after(() => store.close());
  await store.sampleProgress();
  const job = await store.getJob(1);
  assert.equal(job.telemetry.source, attempt.log_path);
  assert.equal(job.telemetry.updated_source, 'record');
  assert.equal(job.telemetry.updated, now - 60);
  assert.equal(job.telemetry.updates, 650);
  assert.equal(job.telemetry.total_updates, 1000);
  assert.equal(job.telemetry.total_epochs, null);
  assert.equal(job.telemetry.total_percent, 65);
  assert.equal(job.estimate.sample_count, 2);
  assert.equal(job.estimate.end_at, now + 80);
  assert.equal((await store.getJob(1)).estimate.sample_count, 2);
});
