import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLogFile } from '../src/data/log-files.js';
import { tail } from '../src/data/files.js';
import { createApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';

const linux = { skip: process.platform !== 'linux' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'panel-safe-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'attempt.log');
  const secret = join(directory, 'operator.env');
  await writeFile(secret, 'synthetic-private-operator-token');
  return { directory, log, secret };
}

async function server(t, log) {
  const store = {
    getLogSource: () => ({ path: log }),
    getLog: async () => tail(log),
  };
  const app = createApp({
    config: readConfig({ PANEL_MODE: 'gpuq', GPUQ_DATABASE: '/synthetic/queue.sqlite3' }, []),
    store,
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve, reject) => app.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${app.address().port}/api/jobs/1/logs/attempt-1`;
}

test('downloads, HEAD and previews refuse a symlink replacing an advertised log', linux, async (t) => {
  const { log, secret } = await fixture(t);
  await symlink(secret, log);
  const url = await server(t, log);
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(url + '/download', { method });
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes('synthetic-private'), false);
  }
  const preview = await fetch(url);
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { text: '', updated: null });
  assert.equal(await openLogFile(log), null);
});

test('parent links, dangling links, directories and dot-dot paths cannot become logs', linux, async (t) => {
  const { directory, log, secret } = await fixture(t);
  const alias = join(directory, 'alias');
  await symlink(directory, alias);
  assert.equal(await openLogFile(join(alias, 'operator.env')), null);
  assert.deepEqual(await tail(join(alias, 'operator.env')), { text: '', updated: null });
  await symlink(join(directory, 'missing'), log);
  assert.equal(await openLogFile(log), null);
  assert.equal(await openLogFile(directory), null);
  assert.equal(await openLogFile('relative.log'), null);
  assert.equal(await openLogFile(directory + '/alias/../operator.env'), null);
  // The denied target still exists; rejection is not just a missing-file result.
  const real = await openLogFile(secret);
  assert.ok(real);
  await real.close();
});

test('rename/create and copytruncate rotation retain current logs and already-open descriptors', linux, async (t) => {
  const { log } = await fixture(t);
  await writeFile(log, 'old log\n');
  const opened = await openLogFile(log);
  assert.ok(opened);
  try {
    await rename(log, log + '.1');
    await writeFile(log, 'replacement log\n');
    assert.equal(await opened.readFile('utf8'), 'old log\n');
    assert.equal((await tail(log)).text, 'replacement log\n');
    const url = await server(t, log);
    assert.equal(await (await fetch(url + '/download')).text(), 'replacement log\n');
    await truncate(log, 0);
    assert.equal((await tail(log)).text, '');
    await writeFile(log, 'after truncation\n');
    assert.equal(await (await fetch(url + '/download')).text(), 'after truncation\n');
  } finally {
    await opened.close();
  }
});

test('an opened log survives parent replacement while later reads reject the new parent link', linux, async (t) => {
  const { directory } = await fixture(t);
  const parent = join(directory, 'run');
  const outside = join(directory, 'private');
  await mkdir(parent);
  await mkdir(outside);
  const path = join(parent, 'run.log');
  await writeFile(path, 'legitimate log');
  await writeFile(join(outside, 'run.log'), 'synthetic-private-content');
  const opened = await openLogFile(path);
  assert.ok(opened);
  try {
    await rename(parent, parent + '.old');
    await symlink(outside, parent);
    assert.equal(await opened.readFile('utf8'), 'legitimate log');
    assert.equal(await openLogFile(path), null);
    assert.equal((await tail(path)).text, '');
    const url = await server(t, path);
    assert.equal((await fetch(url + '/download')).status, 404);
  } finally {
    await opened.close();
  }
});

test('log traversal does not require listing an execute-only parent directory', linux, async (t) => {
  const { directory } = await fixture(t);
  const parent = join(directory, 'traverse-only');
  await mkdir(parent);
  const path = join(parent, 'run.log');
  await writeFile(path, 'readable through execute-only parent');
  await chmod(parent, 0o111);
  try {
    assert.equal((await tail(path)).text, 'readable through execute-only parent');
  } finally {
    await chmod(parent, 0o700);
  }
});
