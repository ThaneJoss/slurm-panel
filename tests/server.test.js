import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server/app.js';
import { readConfig, publicConfig } from '../src/server/config.js';
import { createDemoStore } from '../src/data/demo.js';

async function listen(t, options = {}) {
  const store = options.store ?? createDemoStore();
  const config = options.config ?? readConfig({}, []);
  const server = createApp({ store, config, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close?.();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('configuration is portable and its public projection contains only presentation settings', () => {
  const defaults = readConfig({}, []);
  assert.equal(defaults.mode, 'demo');
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.timeZone, null);
  const config = readConfig({
    PANEL_MODE: 'gpuq', GPUQ_DATABASE: '/srv/example/queue.sqlite3',
    PANEL_TITLE: 'Research queue', HOST: '127.0.0.2', PORT: '8080',
    REFRESH_INTERVAL_MS: '7000', TZ: 'UTC', SLURM_WEB_URL: 'https://slurm.example.org',
  }, []);
  assert.deepEqual(publicConfig(config), {
    title: 'Research queue', slurmWebUrl: 'https://slurm.example.org/',
    refreshIntervalMs: 7000, timeZone: 'UTC', mode: 'gpuq',
    clusterName: 'SLURM',
    capabilities: { cancelJobs: false, cancellationRequiresToken: false, artifacts: true, logDownload: true },
  });
  assert.equal(JSON.stringify(publicConfig(config)).includes('/srv/'), false);
  assert.equal(readConfig({ PANEL_MODE: 'gpuq' }, ['--demo']).mode, 'demo');
});

test('invalid data sources and unsafe external links are configuration errors', () => {
  for (const env of [
    { PANEL_MODE: 'unknown' },
    { PANEL_MODE: 'gpuq' },
    { PANEL_MODE: 'gpuq', GPUQ_DATABASE: 'relative.sqlite3' },
    { SLURM_WEB_URL: 'javascript:alert(1)' },
    { SLURM_WEB_URL: 'https://user:password@slurm.example.org' },
    { PORT: 'not-a-number' },
    { PORT: '65536' },
    { REFRESH_INTERVAL_MS: '0' },
    { TZ: 'Not/A_Time_Zone' },
    { GPU_METRICS_FILE: 'relative-metrics.json' },
  ]) {
    assert.throws(() => readConfig(env, []));
  }
  assert.throws(() => readConfig({}, ['--unknown']));
});

test('HTTP list filters and pages on the server, and invalid query parameters return 400', async (t) => {
  const base = await listen(t);
  const response = await fetch(`${base}/api/jobs?page=2&pageSize=1&state=active&sort=oldest`);
  assert.equal(response.status, 200);
  const listing = await response.json();
  assert.equal(listing.jobs.length, 1);
  assert.equal(listing.jobs[0].id, 5);
  assert.deepEqual(listing.pagination, { page: 2, pageSize: 1, total: 3, totalPages: 3 });
  assert.equal(listing.summary.total, 7);
  assert.equal(listing.summary.active, 3);
  assert.deepEqual(listing.workers.find((worker) => worker.gpu === 6).job_ids, [4]);
  for (const query of ['page=0', 'pageSize=101', 'state=unknown', 'range=forever', 'staleOnly=yes']) {
    const invalid = await fetch(`${base}/api/jobs?${query}`);
    assert.equal(invalid.status, 400, query);
    assert.ok((await invalid.json()).error.includes('query parameter'));
  }
});

test('HTTP API serves the standalone demo with details, logs and public configuration', async (t) => {
  const base = await listen(t);
  const configResponse = await fetch(`${base}/api/config`);
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.mode, 'demo');
  assert.equal(config.databasePath, undefined);
  assert.equal(config.host, undefined);

  const listResponse = await fetch(`${base}/api/jobs`);
  assert.equal(listResponse.headers.get('cache-control'), 'no-store');
  assert.equal(listResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(listResponse.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const listing = await listResponse.json();
  const running = listing.jobs.find((job) => job.state === 'running');
  const detailResponse = await fetch(`${base}/api/jobs/${running.id}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.id, running.id);
  const logResponse = await fetch(`${base}/api/jobs/${running.id}/logs/${detail.logs[0].key}`);
  assert.equal(logResponse.status, 200);
  assert.ok((await logResponse.json()).text.includes('[demo]'));
  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { status: 'ok', mode: 'demo' });
});

test('HTTP is read-only and unknown job/log/path requests cannot access filesystem content', async (t) => {
  const base = await listen(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(`${base}/api/jobs`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    await response.json();
  }
  for (const path of [
    '/api/jobs/99999',
    '/api/jobs/4/logs/not-an-advertised-log',
    '/api/jobs/4/logs/..%2f..%2fetc%2fpasswd',
    '/api/jobs/9007199254740992',
    '/.env', '/.git/config', '/package.json', '/src/server/config.js',
    '/%2e%2e%2fpackage.json', '/static/../../package.json',
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'Not found.' });
  }
});

test('only packaged browser assets are served and HEAD omits the response body', async (t) => {
  const base = await listen(t);
  for (const [path, expectedType] of [
    ['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css'],
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(expectedType));
    assert.ok((await response.text()).length > 0);
  }
  const head = await fetch(`${base}/api/config`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal(await head.text(), '');
});

test('data access errors are reported without leaking local paths or internal messages', async (t) => {
  const internalMessage = 'Cannot open /private/example/queue.sqlite3 using fixture-secret-token';
  const errors = [];
  const base = await listen(t, {
    store: {
      listJobs() { throw new Error(internalMessage); },
      close() {},
    },
    logger: { error(...args) { errors.push(args); } },
  });
  const response = await fetch(`${base}/api/jobs`);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(body.includes('/private/'), false);
  assert.equal(body.includes('fixture-secret-token'), false);
  assert.ok(JSON.parse(body).error);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].message, internalMessage);
});
