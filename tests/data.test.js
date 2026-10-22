import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGpuqStore } from '../src/data/gpuq.js';
import { createDemoStore } from '../src/data/demo.js';
import { createFixture, writeAt } from './fixtures.js';

test('gpuq schema preserves job/retry ordering and excludes submission secrets and internal process fields', async (t) => {
  const fixture = await createFixture(t);
  fixture.job({ attempt_count: 2 });
  fixture.job({ id: 2, state: 'queued' });
  const first = fixture.attempt({ state: 'oom', finished: fixture.now - 100, exit_code: 1 });
  const second = fixture.attempt({ number: 2, log_path: join(fixture.directory, 'attempt-2.log') });
  await writeFile(first.log_path, 'first attempt\n');
  await writeFile(second.log_path, '{"phase":"training","updates":21}\n');
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());

  const listing = await store.listJobs();
  assert.deepEqual(listing.jobs.map((job) => job.id), [2, 1]);
  assert.deepEqual(listing.counts, { queued: 1, running: 1 });
  assert.equal(listing.workers[0].slurm_job_id, 'synthetic-worker');
  assert.equal(listing.workers[0].pid, undefined);
  assert.equal(listing.paused, false);
  assert.equal(listing.manager_heartbeat, fixture.now - 1);
  const detail = await store.getJob(1);
  assert.equal(detail.attempt.number, 2);
  assert.deepEqual(detail.attempts.map((attempt) => attempt.number), [2, 1]);
  assert.equal(detail.telemetry.updates, 21);
  assert.deepEqual(detail.logs.map((log) => log.key), ['attempt-2', 'attempt-1']);
  for (const attempt of detail.attempts) {
    assert.equal(attempt.session, undefined);
    assert.equal(attempt.runner_pid, undefined);
    assert.equal(attempt.train_pid, undefined);
  }
  const serialized = JSON.stringify({ listing, detail });
  for (const secret of ['fixture-secret-token', 'fixture-secret-password', 'API_TOKEN', 'PASSWORD', 'private-session']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(detail.environment, undefined);
  assert.equal(await store.getJob(999), null);
});

test('reading lists, details and logs leaves the queue database unchanged', async (t) => {
  const fixture = await createFixture(t);
  fixture.job({ attempt_count: 1 });
  const attempt = fixture.attempt();
  await writeFile(attempt.log_path, 'read-only fixture\n');
  fixture.finish();
  const before = await readFile(fixture.databasePath);
  const store = createGpuqStore(fixture);
  try {
    await store.listJobs();
    await store.getJob(1);
    assert.equal((await store.getLog(1, 'attempt-1')).text, 'read-only fixture\n');
  } finally {
    store.close();
  }
  assert.deepEqual(await readFile(fixture.databasePath), before);
});

test('output discovery skips result files and supports relative --output-dir= directories', async (t) => {
  const fixture = await createFixture(t);
  const output = join(fixture.cwd, 'relative-run');
  await mkdir(output);
  const resultFile = join(fixture.cwd, 'result.json');
  await writeFile(resultFile, '{}');
  const path = join(output, 'status.json');
  await writeAt(path, JSON.stringify({ phase: 'training', updates: 34, latest_micro_loss: 0.25 }), fixture.now);
  fixture.job({ argv: ['node', 'train.mjs', '--output', resultFile, '--output-dir=relative-run'] });
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());
  const detail = await store.getJob(1);
  assert.equal(detail.telemetry.source, path);
  assert.equal(detail.telemetry.updates, 34);
  assert.equal(detail.telemetry.loss, 0.25);
});

test('output environment hints resolve against cwd and latest valid progress wins', async (t) => {
  const fixture = await createFixture(t);
  const output = join(fixture.cwd, 'run-from-env');
  await mkdir(output);
  await writeAt(join(fixture.cwd, 'status.json'), '{"updates":10}', fixture.now - 20);
  const progress = join(output, 'progress.json');
  await writeAt(progress, JSON.stringify({
    state: 'validating', completed_epoch: 7, updates_per_epoch: 80,
    latest: { updates: 560, samples: 8960, train_loss: 0.125 },
    deadline_at: '2030-01-01T12:00:00Z', queue: { GPUQ_JOB_ID: '1' },
  }), fixture.now - 10);
  fixture.job({ environment: { RUN_DIR: 'run-from-env', API_TOKEN: 'fixture-secret-token' } });
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());
  const { telemetry } = await store.getJob(1);
  assert.equal(telemetry.source, progress);
  assert.equal(telemetry.phase, 'validating');
  assert.equal(telemetry.epoch, 7);
  assert.equal(telemetry.batches, 80);
  assert.equal(telemetry.updates, 560);
  assert.equal(telemetry.samples, 8960);
  assert.equal(telemetry.loss, 0.125);
  assert.equal(telemetry.budget_end, '2030-01-01T12:00:00Z');
});

test('stale, foreign-job and partially written progress cannot replace this job telemetry', async (t) => {
  const fixture = await createFixture(t);
  const status = join(fixture.cwd, 'status.json');
  const progress = join(fixture.cwd, 'progress.json');
  await writeAt(status, '{"updates":999}', fixture.created - 10);
  await writeAt(progress, '{"updates":888,"queue":{"GPUQ_JOB_ID":999}}', fixture.now);
  fixture.job({ attempt_count: 1 });
  const attempt = fixture.attempt();
  await writeFile(attempt.log_path, 'normal output\n{"updates":40,"phase":"training"}\n{"updates":');
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());
  assert.equal((await store.getJob(1)).telemetry.updates, 40);

  await writeAt(status, '{"updates":', fixture.now + 1);
  await writeAt(progress, '{"updates":777,"queue":{"GPUQ_JOB_ID":2}}', fixture.now + 2);
  assert.equal((await store.getJob(1)).telemetry.updates, 40);
});

test('oversized JSON is ignored rather than interpreting a truncated suffix as progress', async (t) => {
  const fixture = await createFixture(t);
  fixture.job();
  fixture.finish();
  await writeFile(join(fixture.cwd, 'status.json'), JSON.stringify({ padding: 'x'.repeat(1024 * 1024), updates: 123 }));
  const store = createGpuqStore(fixture);
  t.after(() => store.close());
  assert.equal((await store.getJob(1)).telemetry, null);
});

test('logs are restricted to advertised sources, exclude stale project logs and read bounded cleaned tails', async (t) => {
  const fixture = await createFixture(t);
  fixture.job({ attempt_count: 1 });
  const attempt = fixture.attempt();
  const ending = '\u001b[31mrecent line\u001b[0m\rnext line\n';
  await writeFile(attempt.log_path, `excluded-prefix\n${'x'.repeat(300 * 1024)}\n${ending}`);
  await writeAt(join(fixture.cwd, 'train.log'), 'stale project output', fixture.created - 10);
  await writeAt(join(fixture.cwd, 'run.log'), 'current project output', fixture.now);
  const unrelated = join(fixture.directory, 'unrelated-secret.txt');
  await writeFile(unrelated, 'must-never-be-returned');
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());

  const detail = await store.getJob(1);
  assert.deepEqual(detail.logs.map((log) => log.path), [attempt.log_path, join(fixture.cwd, 'run.log')]);
  assert.equal(await store.getLog(1, unrelated), null);
  assert.equal(await store.getLog(1, '../unrelated-secret.txt'), null);
  assert.equal(await store.getLog(1, 'attempt-2'), null);
  assert.equal(await store.getLog(999, 'attempt-1'), null);
  const log = await store.getLog(1, 'attempt-1');
  assert.equal(log.path, attempt.log_path);
  assert.ok(Buffer.byteLength(log.text) <= 256 * 1024);
  assert.equal(log.text.includes('excluded-prefix'), false);
  assert.equal(log.text.includes('\u001b'), false);
  assert.equal(log.text.includes('\r'), false);
  assert.ok(log.text.endsWith('recent line\nnext line\n'));
  assert.equal((await store.getLog(1, detail.logs[1].key)).text, 'current project output');
});

test('an attempt log that has not appeared yet remains readable as empty output', async (t) => {
  const fixture = await createFixture(t);
  fixture.job({ attempt_count: 1 });
  fixture.attempt();
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());
  const result = await store.getLog(1, 'attempt-1');
  assert.equal(result.text, '');
  assert.equal(result.updated, null);
  assert.equal((await store.getJob(1)).telemetry, null);
});

test('project log keys keep their source when retries and earlier candidate logs appear', async (t) => {
  const fixture = await createFixture(t);
  const earlierOutput = join(fixture.cwd, 'not-created-yet');
  const selectedOutput = join(fixture.cwd, 'selected-run');
  await mkdir(selectedOutput);
  const selectedPath = join(selectedOutput, 'train.log');
  await writeAt(selectedPath, 'selected training log', fixture.now);
  fixture.job({
    attempt_count: 1,
    environment: { OUTPUT_DIR: earlierOutput, RUN_DIR: selectedOutput },
  });
  fixture.attempt();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());
  const before = await store.getJob(1);
  const selectedKey = before.logs.find((log) => log.path === selectedPath).key;

  // A retry, a previously missing output directory and run.log each used to
  // shift indexes, silently making a selected key read another log source.
  fixture.attempt({ number: 2, log_path: join(fixture.directory, 'attempt-2.log') });
  await mkdir(earlierOutput);
  await writeAt(join(earlierOutput, 'run.log'), 'earlier candidate log', fixture.now);
  await writeAt(join(selectedOutput, 'run.log'), 'new run log', fixture.now);
  fixture.finish();

  const after = await store.getJob(1);
  assert.equal(after.attempt.number, 2);
  assert.ok(after.logs.length > before.logs.length);
  assert.equal(after.logs.find((log) => log.key === selectedKey).path, selectedPath);
  const selected = await store.getLog(1, selectedKey);
  assert.equal(selected.path, selectedPath);
  assert.equal(selected.text, 'selected training log');
});

test('demo returns isolated synthetic data and never exposes private fixture message storage', async () => {
  const store = createDemoStore();
  try {
    const listing = await store.listJobs();
    assert.ok(listing.jobs.length >= 4);
    assert.deepEqual(new Set(listing.jobs.map((job) => job.state)), new Set(['running', 'queued', 'succeeded', 'failed']));
    const job = listing.jobs.find((item) => item.state === 'running');
    const detail = await store.getJob(job.id);
    assert.equal(detail.messages, undefined);
    assert.ok(detail.cwd.startsWith('/demo/'));
    assert.ok((await store.getLog(job.id, detail.logs[0].key)).text.includes('[demo]'));
    detail.name = 'mutated by consumer';
    listing.jobs[0].name = 'mutated listing';
    assert.notEqual((await store.getJob(job.id)).name, 'mutated by consumer');
    assert.notEqual((await store.listJobs()).jobs[0].name, 'mutated listing');
    assert.equal(await store.getJob(9999), null);
    assert.equal(await store.getLog(job.id, '/etc/passwd'), null);
  } finally {
    store.close();
  }
});
