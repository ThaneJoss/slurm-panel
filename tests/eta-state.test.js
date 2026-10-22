import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGpuqStore } from '../src/data/gpuq.js';
import { createFixture } from './fixtures.js';

test('the panel restores its own ETA state larger than training progress documents', async (t) => {
  const fixture = await createFixture(t);
  const attempts = [];
  for (let id = 1; id <= 64; id += 1) {
    fixture.job({ id, argv: ['train.py', '--epochs', '1000'] });
    attempts.push(fixture.attempt({ job_id: id, started: fixture.now - 1000,
      log_path: join(fixture.directory, `attempt-${id}.log`) }));
  }
  fixture.finish();
  await Promise.all(attempts.map((attempt) => writeFile(attempt.log_path,
    Array.from({ length: 256 }, (_, index) => JSON.stringify({
      completed_epochs: index + 1, phase: 'training', timestamp: fixture.now - 900 + index,
    })).join('\n') + '\n')));
  const etaStateFile = join(fixture.directory, 'eta.json');
  const store = createGpuqStore({ databasePath: fixture.databasePath, etaStateFile });
  let before;
  try {
    await store.sampleProgress();
    before = await store.getJob(1);
    assert.equal(before.estimate.sample_count, 256);
    assert.ok((await stat(etaStateFile)).size > 1024 * 1024);
    assert.equal(JSON.parse(await readFile(etaStateFile, 'utf8')).histories.length, 64);
  } finally {
    store.close();
  }
  await Promise.all(attempts.map((attempt) => rm(attempt.log_path)));
  const restarted = createGpuqStore({ databasePath: fixture.databasePath, etaStateFile });
  t.after(() => restarted.close());
  const after = await restarted.getJob(1);
  assert.equal(after.estimate?.sample_count, before.estimate.sample_count);
  assert.equal(after.estimate?.end_at, before.estimate.end_at);
});
