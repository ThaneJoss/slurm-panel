import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGpuqStore } from '../src/data/gpuq.js';
import { createFixture, writeAt } from './fixtures.js';

test('SQLite searches and pages complete history while range statistics and worker tasks remain independent of the page', async (t) => {
  const fixture = await createFixture(t);
  for (let id = 1; id <= 230; id += 1) {
    fixture.job({
      id,
      name: id === 1 ? 'Unique old experiment' : `Experiment ${id}`,
      state: id === 1 ? 'failed' : id === 2 || id === 3 ? 'running' : 'succeeded',
      created: id === 1 ? fixture.now - 3 * 86400 : fixture.created,
    });
  }
  fixture.attempt({ job_id: 2, log_path: join(fixture.directory, 'job-2.log') });
  fixture.attempt({ job_id: 3, log_path: join(fixture.directory, 'job-3.log') });
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());

  const last = await store.listJobs({ page: 3, pageSize: 100, sort: 'newest' });
  assert.deepEqual(last.pagination, { page: 3, pageSize: 100, total: 230, totalPages: 3 });
  assert.equal(last.jobs.at(-1).id, 1);
  assert.deepEqual(last.workers[0].job_ids, [3, 2]);
  assert.equal(last.workers[0].state, 'unknown');

  const search = await store.listJobs({ q: 'UNIQUE old', state: 'failed' });
  assert.deepEqual(search.jobs.map((job) => job.id), [1]);
  assert.equal(search.pagination.total, 1);
  assert.equal(search.summary.total, 230);
  assert.equal(search.summary.active, 2);
  assert.equal(search.summary.succeeded, 227);
  assert.equal(search.counts.failed, 1);
  assert.equal(search.counts.running, 2);

  const recent = await store.listJobs({ q: 'UNIQUE old', state: 'failed', range: '24h' });
  assert.deepEqual(recent.jobs, []);
  assert.equal(recent.pagination.total, 0);
  assert.equal(recent.summary.total, 229);
  assert.equal(recent.summary.active, 2);
  assert.equal(recent.counts.failed, undefined);
  assert.deepEqual(recent.workers[0].job_ids, [3, 2]);
});

test('stale progress supports a display-only filter and summary without changing running state', async (t) => {
  const fixture = await createFixture(t);
  fixture.job({ id: 1, argv: ['node', 'train.mjs', '--seed=44', '--epochs', '90'] });
  fixture.job({ id: 2 });
  fixture.job({ id: 3, state: 'succeeded' });
  const old = fixture.attempt({ started: fixture.now - 1800, log_path: join(fixture.directory, 'old.log') });
  const fresh = fixture.attempt({ job_id: 2, started: fixture.now - 1800, log_path: join(fixture.directory, 'fresh.log') });
  await writeAt(old.log_path, JSON.stringify({ phase: 'training', epoch: 48, total_epochs: 90, eta_seconds: 3720, timestamp: fixture.now - 700 }) + '\n', fixture.now - 700);
  await writeAt(fresh.log_path, '{"phase":"training","updates":42}\n', fixture.now - 10);
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());

  const listing = await store.listJobs({ staleOnly: true });
  assert.equal(listing.summary.stale, 1);
  assert.equal(listing.summary.active, 2);
  assert.equal(listing.pagination.total, 1);
  assert.deepEqual(listing.jobs.map((job) => job.id), [1]);
  const stale = listing.jobs[0];
  assert.equal(stale.state, 'running');
  assert.equal(stale.stale, true);
  assert.ok(stale.stale_seconds >= 700);
  assert.equal(stale.telemetry.total_epochs, 90);
  assert.equal(stale.telemetry.eta_seconds, 3720);
  assert.ok(stale.tags.includes('seed 44'));
  assert.deepEqual(listing.workers[0].job_ids, [2, 1]);
});

test('scheduler GPU snapshots expose only metric fields and malformed updates stay unavailable', async (t) => {
  const fixture = await createFixture(t);
  fixture.job({ state: 'queued' });
  fixture.finish();
  const metricsFile = join(fixture.directory, 'private-exporter-location.json');
  await writeFile(metricsFile, JSON.stringify({
    producer_secret: 'private-exporter-token',
    gpus: [{
      gpu: 0, utilization_percent: 96,
      memory_used_bytes: 18.6 * 1024 ** 3, memory_total_bytes: 24 * 1024 ** 3,
      updated: fixture.now - 2, private_path: '/private/exporter/internal',
    }],
  }));
  const store = createGpuqStore({ databasePath: fixture.databasePath, metricsFile });
  t.after(() => store.close());

  const listing = await store.listJobs();
  assert.deepEqual(listing.workers[0].metrics, {
    utilization_percent: 96,
    utilization_5m_percent: null,
    utilization_window_seconds: null,
    memory_used_bytes: 18.6 * 1024 ** 3,
    memory_total_bytes: 24 * 1024 ** 3,
    processes: null,
    process_count: null,
    updated: fixture.now - 2,
  });
  const serialized = JSON.stringify(listing);
  assert.equal(serialized.includes(metricsFile), false);
  assert.equal(serialized.includes('private-exporter-token'), false);
  assert.equal(serialized.includes('/private/exporter/internal'), false);

  await writeFile(metricsFile, '{"gpus":');
  assert.equal((await store.listJobs()).workers[0].metrics, null);

  // gpuq's scheduler snapshot reports MiB and free memory; consume it without
  // invoking status commands or changing the producer's schema.
  await writeAt(metricsFile, JSON.stringify({
    gpus: [{ gpu: 0, utilization: 64, total_mib: 24576, free_mib: 6144 }],
  }), fixture.now);
  const snapshotUpdated = (await stat(metricsFile)).mtimeMs / 1000;
  assert.deepEqual((await store.listJobs()).workers[0].metrics, {
    utilization_percent: 64,
    utilization_5m_percent: null,
    utilization_window_seconds: null,
    memory_used_bytes: 18 * 1024 ** 3,
    memory_total_bytes: 24 * 1024 ** 3,
    processes: null,
    process_count: null,
    updated: snapshotUpdated,
  });
});

test('ordinary log output does not refresh old structured progress timestamps or observation times', async (t) => {
  const fixture = await createFixture(t);
  fixture.job({ id: 1 });
  fixture.job({ id: 2 });
  const timestamped = fixture.attempt({ job_id: 1, started: fixture.now - 1800 });
  const observed = fixture.attempt({ job_id: 2, started: fixture.now - 1800, log_path: join(fixture.directory, 'observed.log') });
  await writeFile(timestamped.log_path, JSON.stringify({ epoch: 12, timestamp: fixture.now - 700 }) + '\nnormal heartbeat\n');
  await writeFile(observed.log_path, '{"epoch":12}\nnormal heartbeat\n');
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());

  const first = await store.getJob(1);
  assert.equal(first.telemetry.updated_source, 'record');
  assert.equal(first.stale, true);
  const untimestamped = await store.getJob(2);
  assert.equal(untimestamped.telemetry.updated_source, 'observed');
  await writeFile(timestamped.log_path, 'another normal heartbeat\n', { flag: 'a' });
  await writeFile(observed.log_path, 'another normal heartbeat\n', { flag: 'a' });
  const repeated = await store.getJob(1);
  assert.equal(repeated.telemetry.updated, first.telemetry.updated);
  assert.equal(repeated.stale, true);
  assert.equal((await store.getJob(2)).telemetry.updated, untimestamped.telemetry.updated);
  await writeFile(observed.log_path, '{"epoch":13}\n', { flag: 'a' });
  assert.equal((await store.getJob(2)).telemetry.epoch, 13);
});

test('artifact metadata is limited to explicit output locations without reading files, descending directories or following entry links', async (t) => {
  const fixture = await createFixture(t);
  const output = join(fixture.cwd, 'run-output');
  const nested = join(output, 'nested');
  await mkdir(nested, { recursive: true });
  const modelPath = join(output, 'best.pt');
  const modelContent = 'private-model-content-must-not-be-read';
  await writeFile(modelPath, modelContent);
  await chmod(modelPath, 0o000);
  await writeFile(join(output, 'result.json'), '{"private_result":"not-exposed"}');
  await writeFile(join(output, '.hidden.json'), 'not an advertised artifact');
  await writeFile(join(fixture.cwd, 'cwd-secret.json'), 'outside explicit output');
  await writeFile(join(nested, 'deep.pt'), 'not recursively scanned');
  const externalPath = join(fixture.directory, 'external.pt');
  await writeFile(externalPath, 'not followed through a symlink');
  await symlink(externalPath, join(output, 'linked.pt'));
  await symlink(nested, join(output, 'linked-directory'));
  fixture.job({ environment: { OUTPUT_DIR: 'run-output' } });
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());

  const artifacts = await store.getArtifacts(1);
  assert.deepEqual(artifacts.directories, [output]);
  assert.deepEqual(artifacts.files.map((file) => file.name), ['best.pt', 'result.json']);
  assert.equal(artifacts.files[0].path, modelPath);
  assert.equal(artifacts.files[0].size, Buffer.byteLength(modelContent));
  assert.equal(typeof artifacts.files[0].modified, 'number');
  assert.equal(artifacts.truncated, false);
  const serialized = JSON.stringify(artifacts);
  assert.equal(serialized.includes(modelContent), false);
  assert.equal(serialized.includes('not-exposed'), false);
  assert.equal(serialized.includes('cwd-secret'), false);
  assert.equal(serialized.includes('linked.pt'), false);
  assert.equal(serialized.includes('deep.pt'), false);
  assert.equal(await store.getArtifacts(999), null);
});

test('full-log source discovery only resolves advertised keys for known jobs', async (t) => {
  const fixture = await createFixture(t);
  fixture.job();
  const attempt = fixture.attempt();
  fixture.finish();
  const store = createGpuqStore(fixture);
  t.after(() => store.close());

  const source = await store.getLogSource(1, 'attempt-1');
  assert.equal(source.key, 'attempt-1');
  assert.equal(source.path, attempt.log_path);
  assert.equal(typeof source.label, 'string');
  assert.equal(source.session, undefined);
  assert.equal(await store.getLogSource(1, 'attempt-2'), null);
  assert.equal(await store.getLogSource(1, '../queue.sqlite3'), null);
  assert.equal(await store.getLogSource(1, attempt.log_path), null);
  assert.equal(await store.getLogSource(999, 'attempt-1'), null);
});
