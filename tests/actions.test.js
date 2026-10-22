import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { readConfig, publicConfig } from '../src/server/config.js';
import { createDemoStore } from '../src/data/demo.js';

const fakeToken = 'synthetic-operator-token';

function syntheticStore({ logPath = null, text = '[demo] complete synthetic log\n' } = {}) {
  const jobs = new Map([[1, { id: 1, state: 'running' }], [2, { id: 2, state: 'succeeded' }]]);
  return {
    getJob(id) { return jobs.has(id) ? structuredClone(jobs.get(id)) : null; },
    getLog(id, key) { return id === 1 && key === 'attempt-1' ? { text, path: '/demo/attempt-1.log' } : null; },
    getLogSource(id, key) { return id === 1 && key === 'attempt-1' ? { key, label: 'Synthetic log', path: logPath } : null; },
    getArtifacts(id) {
      return jobs.has(id)
        ? { directories: ['/demo/run'], files: [{ name: 'best.pt', path: '/demo/run/best.pt', size: 1234, modified: 123 }], truncated: false }
        : null;
    },
    cancelJob(id) {
      const job = jobs.get(id);
      if (!job) return null;
      job.state = 'cancelled';
      return structuredClone(job);
    },
    close() {},
  };
}

function liveConfig(extra = {}) {
  return readConfig({
    PANEL_MODE: 'gpuq', GPUQ_DATABASE: '/synthetic/state/queue.sqlite3',
    ENABLE_JOB_CONTROL: '1', JOB_CONTROL_TOKEN: fakeToken,
    GPUQ_COMMAND: '/synthetic/bin/gpuq', ...extra,
  }, []);
}

async function listen(t, options = {}) {
  const store = options.store ?? syntheticStore();
  const config = options.config ?? readConfig({}, []);
  const errors = [];
  const server = createApp({ store, config, logger: { error: (...args) => errors.push(args) }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, store, errors };
}

function cancellation(headers = {}, body = '{}') {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body };
}

test('operator settings stay private and live cancellation requires explicit complete configuration', () => {
  const live = liveConfig();
  assert.deepEqual(publicConfig(live).capabilities, {
    cancelJobs: true, cancellationRequiresToken: true, artifacts: true, logDownload: true,
  });
  const publicText = JSON.stringify(publicConfig(live));
  assert.equal(publicText.includes(fakeToken), false);
  assert.equal(publicText.includes('/synthetic/'), false);
  assert.equal(publicConfig(readConfig({ PANEL_MODE: 'gpuq', GPUQ_DATABASE: '/synthetic/db' }, [])).capabilities.cancelJobs, false);
  for (const extra of [
    { JOB_CONTROL_TOKEN: '' }, { ENABLE_JOB_CONTROL: 'yes' }, { JOB_CONTROL_TOKEN: 'contains space' },
    { PANEL_PUBLIC_ORIGIN: 'javascript:bad' }, { PANEL_PUBLIC_ORIGIN: 'https://example.org/path' },
    { PANEL_PUBLIC_ORIGIN: 'https://user:password@example.org' },
  ]) assert.throws(() => liveConfig(extra));
});

test('demo cancellation changes only its synthetic state and rejects terminal or unknown jobs', async (t) => {
  let calls = 0;
  const { base, store } = await listen(t, { runCommand() { calls += 1; } });
  const response = await fetch(`${base}/api/jobs/1/cancel`, cancellation());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, id: 1, state: 'cancelled' });
  assert.equal(store.getJob(1).state, 'cancelled');
  assert.equal(calls, 0);
  for (const id of [1, 2]) {
    const terminal = await fetch(`${base}/api/jobs/${id}/cancel`, cancellation());
    assert.equal(terminal.status, 409);
    await terminal.json();
  }
  const missing = await fetch(`${base}/api/jobs/999/cancel`, cancellation());
  assert.equal(missing.status, 404);
  await missing.json();
  const read = await fetch(`${base}/api/jobs/1/cancel`);
  assert.equal(read.status, 405);
  assert.equal(read.headers.get('allow'), 'POST');
  await read.json();
});

test('live cancellation is read-only by default and never reaches the command runner', async (t) => {
  let calls = 0;
  const { base } = await listen(t, {
    config: readConfig({ PANEL_MODE: 'gpuq', GPUQ_DATABASE: '/synthetic/db' }, []),
    runCommand() { calls += 1; },
  });
  const response = await fetch(`${base}/api/jobs/1/cancel`, cancellation({ Authorization: `Bearer ${fakeToken}` }));
  assert.equal(response.status, 403);
  await response.json();
  assert.equal(calls, 0);
});

test('authentication, origin and JSON validation reject unsafe cancellation requests before dispatch', async (t) => {
  let calls = 0;
  const { base } = await listen(t, { config: liveConfig(), runCommand() { calls += 1; } });
  for (const authorization of [undefined, 'Bearer wrong', 'Basic synthetic']) {
    const headers = authorization ? { Authorization: authorization } : {};
    const response = await fetch(`${base}/api/jobs/1/cancel`, cancellation(headers));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    await response.json();
  }
  const authorized = { Authorization: `Bearer ${fakeToken}` };
  const cases = [
    [cancellation({ ...authorized, Origin: 'https://unrelated.example' }), 403],
    [cancellation({ ...authorized, Origin: 'null' }), 403],
    [cancellation({ ...authorized, 'Content-Type': 'text/plain' }), 415],
    [cancellation(authorized, '{broken'), 400],
    [cancellation(authorized, 'null'), 400],
    [cancellation(authorized, '[]'), 400],
    [cancellation(authorized, JSON.stringify({ padding: 'x'.repeat(4096) })), 413],
  ];
  for (const [options, status] of cases) {
    const response = await fetch(`${base}/api/jobs/1/cancel`, options);
    assert.equal(response.status, status);
    await response.json();
  }
  assert.equal(calls, 0);
});

test('authenticated dispatch passes only a numeric task ID to gpuq and reports a pending cancellation', async (t) => {
  const calls = [];
  const { base, store } = await listen(t, {
    config: liveConfig(), runCommand: async (...args) => { calls.push(args); },
  });
  const response = await fetch(`${base}/api/jobs/1/cancel`, cancellation({
    Authorization: `Bearer ${fakeToken}`, Origin: base,
  }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, id: 1, state: 'cancellation_requested' });
  assert.deepEqual(calls, [['/synthetic/bin/gpuq', ['cancel', '1']]]);
  assert.equal(store.getJob(1).state, 'running', 'The API must not claim that a queue command has already stopped a job.');
  const injection = await fetch(`${base}/api/jobs/1%3Buname/cancel`, cancellation({ Authorization: `Bearer ${fakeToken}` }));
  assert.equal(injection.status, 405);
  await injection.json();
  assert.equal(calls.length, 1);
});

test('configured public origin supports HTTPS proxies without trusting arbitrary forwarded headers', async (t) => {
  const calls = [];
  const { base } = await listen(t, {
    config: liveConfig({ PANEL_PUBLIC_ORIGIN: 'https://panel.example.org' }),
    runCommand: async (...args) => { calls.push(args); },
  });
  const response = await fetch(`${base}/api/jobs/1/cancel`, cancellation({
    Authorization: `Bearer ${fakeToken}`, Origin: 'https://panel.example.org',
  }));
  assert.equal(response.status, 202);
  await response.json();
  assert.equal(calls.length, 1);
});

test('command failures return a public error without exposing operator or server details', async (t) => {
  const { base, errors } = await listen(t, {
    config: liveConfig(), runCommand() { throw new Error(`private /synthetic/command failure ${fakeToken}`); },
  });
  const response = await fetch(`${base}/api/jobs/1/cancel`, cancellation({ Authorization: `Bearer ${fakeToken}` }));
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(body.includes(fakeToken), false);
  assert.equal(body.includes('/synthetic/'), false);
  assert.equal(errors.length, 1);
});

test('artifact metadata is allowlisted by task and supports HEAD without a body', async (t) => {
  const { base } = await listen(t);
  const response = await fetch(`${base}/api/jobs/1/artifacts`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).files[0].name, 'best.pt');
  const head = await fetch(`${base}/api/jobs/1/artifacts`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal(await head.text(), '');
  for (const path of ['/api/jobs/999/artifacts', '/api/jobs/1/artifacts/..%2f..%2fprivate']) {
    const missing = await fetch(`${base}${path}`);
    assert.equal(missing.status, 404);
    await missing.json();
  }
});

test('cancelling a demo task preserves its existing output files and metadata', async (t) => {
  const store = createDemoStore();
  const job = store.listJobs().jobs.find((item) => item.state === 'running');
  const { base } = await listen(t, { store });
  const beforeResponse = await fetch(`${base}/api/jobs/${job.id}/artifacts`);
  assert.equal(beforeResponse.status, 200);
  const before = await beforeResponse.json();
  assert.ok(before.files.length > 0);

  const response = await fetch(`${base}/api/jobs/${job.id}/cancel`, cancellation());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'cancelled');
  const afterResponse = await fetch(`${base}/api/jobs/${job.id}/artifacts`);
  assert.equal(afterResponse.status, 200);
  assert.deepEqual(await afterResponse.json(), before);
});

test('real log downloads stream the full known file and never use the log tail endpoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'slurm-panel-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, 'full.log');
  const text = `first line\n${'x'.repeat(320 * 1024)}\nlast line\n`;
  await writeFile(logPath, text);
  const store = syntheticStore({ logPath });
  store.getLog = () => { throw new Error('A full download cannot call the tail reader.'); };
  const { base } = await listen(t, { config: liveConfig(), store });
  const response = await fetch(`${base}/api/jobs/1/logs/attempt-1/download`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="job-1-attempt-1.log"');
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text));
  assert.equal(await response.text(), text);
  const head = await fetch(`${base}/api/jobs/1/logs/attempt-1/download`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(text));
  assert.equal(await head.text(), '');
  for (const path of [
    '/api/jobs/1/logs/not-advertised/download', '/api/jobs/999/logs/attempt-1/download',
    '/api/jobs/1/logs/..%2f..%2fetc%2fpasswd/download',
  ]) {
    const unknown = await fetch(`${base}${path}`);
    assert.equal(unknown.status, 404);
    await unknown.json();
  }
});

test('missing, empty and directory log sources do not become arbitrary filesystem downloads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'slurm-panel-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, 'source');
  const { base } = await listen(t, { config: liveConfig(), store: syntheticStore({ logPath }) });
  const missing = await fetch(`${base}/api/jobs/1/logs/attempt-1/download`);
  assert.equal(missing.status, 404);
  await missing.json();
  await mkdir(logPath);
  const notFile = await fetch(`${base}/api/jobs/1/logs/attempt-1/download`);
  assert.equal(notFile.status, 404);
  await notFile.json();
  await rm(logPath, { recursive: true });
  await writeFile(logPath, '');
  const empty = await fetch(`${base}/api/jobs/1/logs/attempt-1/download`);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), '');
});

test('demo download returns the synthetic complete text without opening its fictional path', async (t) => {
  const text = '[demo] synthetic log with no real file behind it\n';
  const { base } = await listen(t, { store: syntheticStore({ text }) });
  const response = await fetch(`${base}/api/jobs/1/logs/attempt-1/download`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), text);
});
