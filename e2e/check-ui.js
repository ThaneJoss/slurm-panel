import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';
import { createDemoStore } from '../src/data/demo.js';

// All records and all mutations in this check belong to this in-memory demo.
const config = readConfig({
  PANEL_MODE: 'demo', PANEL_TITLE: '实验进度', PANEL_CLUSTER_NAME: 'DEMO', REFRESH_INTERVAL_MS: '1000',
}, []);
const store = createDemoStore();
const server = createApp({ config, store });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const screenshots = process.env.PANEL_SCREENSHOT_DIR ? resolve(process.env.PANEL_SCREENSHOT_DIR) : null;

let browser;
try {
  const response = await fetch(`${origin}/api/jobs?pageSize=100`);
  assert.equal(response.status, 200);
  const fixture = await response.json();
  const publicSettings = await (await fetch(`${origin}/api/config`)).json();
  const runningJobs = fixture.jobs.filter((job) => job.state === 'running');
  const queuedJob = fixture.jobs.find((job) => job.state === 'queued');
  const finishedJob = fixture.jobs.find((job) => job.state === 'succeeded');
  const cancelledJob = fixture.jobs.find((job) => job.state === 'cancelled');
  const staleJob = fixture.jobs.find((job) => job.stale);
  assert.ok(runningJobs.length >= 2 && queuedJob && finishedJob && cancelledJob && staleJob,
    'The design demo must exercise distinct task states and a delayed progress report.');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  const consoleErrors = [];
  const listRequests = [];
  const checks = [];
  const listPattern = /\/api\/jobs(?:\?.*)?$/;
  let expectedHttpErrors = 0;
  let failNextList = false;
  let syntheticPagination = false;
  let injectName = false;
  let delayedJobId = null;
  let notifyDelayedRequest;
  let releaseDelayedRequest;
  let notifyDelayedCompletion;
  let delayNextList = false;
  let notifySlowList;
  let releaseSlowList;
  const maliciousName = '<img src=x onerror="window.__panelXss = true"> & "quoted"';

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location().url;
    if (listPattern.test(location) && message.text().includes('503')) {
      expectedHttpErrors += 1;
      return;
    }
    consoleErrors.push({ text: message.text(), location });
  });

  await page.route(listPattern, async (route) => {
    const url = new URL(route.request().url());
    listRequests.push(url);
    if (delayNextList) {
      delayNextList = false;
      const released = new Promise((resolveRequest) => { releaseSlowList = resolveRequest; });
      notifySlowList();
      await released;
    }
    if (failNextList) {
      failNextList = false;
      await route.fulfill({ status: 503, json: { error: 'Intentional demo API failure.' } });
      return;
    }
    const result = await route.fetch();
    const data = await result.json();
    if (injectName && data.jobs[0]) data.jobs[0].name = maliciousName;
    if (syntheticPagination) {
      const requestedPage = Number(url.searchParams.get('page') || 1);
      data.pagination = { page: requestedPage, pageSize: 10, total: 20, totalPages: 2 };
    }
    await route.fulfill({ response: result, json: data });
  });

  await page.route(/\/api\/jobs\/[1-9]\d*$/, async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    const result = await route.fetch();
    const job = await result.json();
    if (injectName) job.name = maliciousName;
    if (id !== delayedJobId) {
      await route.fulfill({ response: result, json: job });
      return;
    }
    delayedJobId = null;
    const released = new Promise((resolveRequest) => { releaseDelayedRequest = resolveRequest; });
    notifyDelayedRequest();
    await released;
    try {
      await route.fulfill({ response: result, json: job });
    } catch (error) {
      // The old request is expected to have been aborted when another task wins.
      if (!route.request().failure()) throw error;
    } finally {
      notifyDelayedCompletion();
    }
  });

  async function waitForIdle() {
    await page.waitForFunction(() => document.getElementById('jobs').getAttribute('aria-busy') !== 'true');
  }
  async function refresh() {
    await page.locator('#refresh').click();
    await waitForIdle();
  }
  async function expectText(selector, text) {
    await page.waitForFunction(({ selector: target, text: expected }) => (
      document.querySelector(target)?.textContent.includes(expected)
    ), { selector, text });
  }
  async function clickJob(id) {
    await page.locator(`#jobs .job[data-id="${id}"]`).click();
    await expectText('#detail h2', `#${id}`);
  }
  async function queryChange(action, parameter, expected) {
    const requested = page.waitForResponse((result) => {
      const url = new URL(result.url());
      return url.pathname === '/api/jobs' && (url.searchParams.get(parameter) ?? '') === String(expected);
    });
    await action();
    await requested;
    await waitForIdle();
  }
  async function noHorizontalOverflow() {
    const widths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    assert.ok(widths.document <= widths.viewport + 1, JSON.stringify(widths));
    assert.ok(widths.body <= widths.viewport + 1, JSON.stringify(widths));
  }

  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('#jobs .job').first().waitFor();
  await page.locator('#detail h2').waitFor();
  await waitForIdle();
  assert.equal(await page.title(), config.title);
  assert.equal(await page.locator('#demo-badge').isVisible(), true);
  assert.equal(await page.locator('.metric').count(), 5);
  assert.deepEqual(await page.locator('.metric strong').allTextContents(),
    ['active', 'queued', 'succeeded', 'failed', 'cancelled'].map((key) => String(fixture.summary[key])));
  assert.equal(await page.locator('#workers .worker').count(), fixture.workers.length);
  assert.equal(await page.locator('#jobs .job').count(), fixture.jobs.length);
  await noHorizontalOverflow();
  checks.push('five status cards and global executor strip');

  await page.locator('#auto').uncheck();
  const pausedAt = listRequests.length;
  await page.waitForTimeout(config.refreshIntervalMs + 150);
  assert.equal(listRequests.length, pausedAt, 'Disabling refresh must stop automatic list requests.');
  await page.locator('#auto').check();
  const resumed = page.waitForRequest((request) => listPattern.test(request.url()));
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await resumed;
  await page.locator('#auto').uncheck();
  await waitForIdle();
  checks.push('manual refresh, automatic refresh and restored-page lifecycle');

  const slowListStarted = new Promise((resolveRequest) => { notifySlowList = resolveRequest; });
  delayNextList = true;
  await page.locator('#refresh').click();
  await slowListStarted;
  const requestsDuringSlowRead = listRequests.length;
  await page.locator('#auto').check();
  try {
    await page.waitForTimeout(config.refreshIntervalMs * 2 + 150);
    assert.equal(listRequests.length, requestsDuringSlowRead,
      'Polling must wait for an in-flight list request even when it outlasts the refresh interval.');
  } finally {
    releaseSlowList();
  }
  await waitForIdle();
  await page.locator('#auto').uncheck();
  checks.push('slow reads are not repeatedly cancelled by automatic polling');

  await page.locator('#workers-toggle').click();
  assert.equal(await page.locator('#workers').isVisible(), false);
  await page.locator('#workers-toggle').click();
  assert.equal(await page.locator('#workers').isVisible(), true);
  const workerJob = fixture.workers.flatMap((worker) => worker.job_ids ?? [])[0];
  assert.ok(workerJob, 'The demo must associate active tasks with executors.');
  await page.locator('#workers .worker-job').filter({ hasText: `任务 #${workerJob}` }).click();
  await expectText('#detail h2', `#${workerJob}`);
  checks.push('executor collapse and linked active task selection');

  await queryChange(() => page.locator('#search').fill(queuedJob.name), 'q', queuedJob.name);
  assert.equal(await page.locator('#jobs .job').count(), 1);
  await expectText('#jobs', queuedJob.name);
  await queryChange(() => page.locator('#search').fill('no-such-demo-experiment'), 'q', 'no-such-demo-experiment');
  assert.equal(await page.locator('#jobs .job').count(), 0);
  await queryChange(() => page.locator('#search').fill(''), 'q', '');
  await queryChange(() => page.locator('#list-tabs [data-state="active"]').click(), 'state', 'active');
  assert.equal(await page.locator('#jobs .job').count(), runningJobs.length);
  await queryChange(() => page.locator('#list-tabs [data-state="failed"]').click(), 'state', 'failed');
  assert.ok(await page.locator('#jobs .job').count() >= 1);
  await queryChange(() => page.locator('#list-tabs [data-state="all"]').click(), 'state', 'all');
  await queryChange(() => page.locator('#sort').selectOption('oldest'), 'sort', 'oldest');
  await queryChange(() => page.locator('#sort').selectOption('active'), 'sort', 'active');
  await queryChange(() => page.locator('#range').selectOption('24h'), 'range', '24h');
  await queryChange(() => page.locator('#range').selectOption('all'), 'range', 'all');
  await queryChange(() => page.locator('#stale-filter').click(), 'staleOnly', '1');
  assert.ok(await page.locator('#jobs .job').count() >= 1);
  await expectText('#jobs', staleJob.name);
  await queryChange(() => page.locator('#stale-filter').click(), 'staleOnly', '0');
  checks.push('server-side search, history, order and delayed-progress filter');

  syntheticPagination = true;
  await refresh();
  await queryChange(() => page.locator('#page-next').click(), 'page', '2');
  assert.equal(await page.locator('#page-prev').isDisabled(), false);
  await queryChange(() => page.locator('#page-prev').click(), 'page', '1');
  assert.equal(await page.locator('#page-prev').isDisabled(), true);
  syntheticPagination = false;
  await refresh();
  checks.push('pagination forwards and backwards with server totals');

  const activeId = runningJobs.find((job) => !job.stale)?.id ?? runningJobs[0].id;
  await clickJob(activeId);
  await page.getByRole('tab', { name: '日志', exact: true }).click();
  const detail = await (await fetch(`${origin}/api/jobs/${activeId}`)).json();
  await page.locator('#log-source').selectOption(detail.logs[0].key);
  const expectedLog = await (await fetch(`${origin}/api/jobs/${activeId}/logs/${detail.logs[0].key}`)).json();
  await expectText('#log', expectedLog.text.trim().split('\n')[0]);
  await page.locator('#follow-log').uncheck();
  assert.equal(await page.locator('#follow-log').isChecked(), false);
  await page.locator('#follow-log').check();
  await page.getByRole('button', { name: '复制日志', exact: true }).click();
  await expectText('#detail .detail-announcement', '已复制');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedLog.text);
  if (publicSettings.capabilities.logDownload) {
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载日志', exact: true }).click();
    const download = await downloadReady;
    assert.ok(download.suggestedFilename().endsWith('.log'));
    assert.equal(await download.failure(), null);
  } else {
    assert.equal(await page.locator('[aria-label="下载日志"]').isDisabled(), true);
  }
  await page.getByRole('tab', { name: '配置', exact: true }).click();
  await expectText('#detail', detail.cwd);
  await page.getByRole('button', { name: '复制配置', exact: true }).click();
  await expectText('#detail .detail-announcement', '配置已复制');
  const copiedConfig = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copiedConfig.includes(detail.cwd));
  assert.equal(copiedConfig.includes('environment'), false);
  await page.getByRole('tab', { name: '运行记录', exact: true }).click();
  await expectText('#detail', String(detail.attempt.slurm_job_id));
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByRole('button', { name: '查看全部', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '日志', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  checks.push('four detail tabs, log sources, follow, copying and full-log download');

  const artifactButton = page.getByRole('button', { name: '查看产物', exact: true });
  if (publicSettings.capabilities.artifacts) {
    await artifactButton.click();
    const dialog = page.getByRole('dialog', { name: '任务产物' });
    await dialog.waitFor();
    await expectText('dialog[open]', '/demo/');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  } else {
    assert.equal(await artifactButton.isDisabled(), true);
  }
  checks.push('artifact metadata inspection follows advertised capability');

  await clickJob(queuedJob.id);
  const delayedStarted = new Promise((resolveRequest) => { notifyDelayedRequest = resolveRequest; });
  const delayedCompleted = new Promise((resolveRequest) => { notifyDelayedCompletion = resolveRequest; });
  delayedJobId = activeId;
  await page.locator(`#jobs .job[data-id="${activeId}"]`).click();
  await delayedStarted;
  await clickJob(queuedJob.id);
  releaseDelayedRequest();
  await delayedCompleted;
  await expectText('#detail h2', `#${queuedJob.id}`);
  assert.equal(await page.locator('#detail h2').innerText(), `#${queuedJob.id} · ${queuedJob.name}`);
  checks.push('late responses cannot replace the selected task');

  const existingRows = await page.locator('#jobs .job').count();
  failNextList = true;
  await refresh();
  assert.equal(await page.locator('#error').isVisible(), true);
  assert.equal(await page.locator('#jobs .job').count(), existingRows);
  await refresh();
  assert.equal(await page.locator('#error').isVisible(), false);
  checks.push('failed requests preserve data and recover on refresh');

  await clickJob(activeId);
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.locator('#log').waitFor();
  await page.waitForFunction(() => {
    const text = document.getElementById('log')?.textContent;
    return text && !text.includes('正在读取日志');
  });
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: resolve(screenshots, 'slurm-panel-desktop.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow();
  if (screenshots) await page.screenshot({ path: resolve(screenshots, 'slurm-panel-mobile.png'), fullPage: true });
  checks.push('1536 px desktop and 390 px mobile layouts');

  injectName = true;
  await refresh();
  const injectedId = Number(await page.locator('#jobs .job').first().getAttribute('data-id'));
  await clickJob(injectedId);
  await expectText('#detail h2', maliciousName);
  assert.equal(await page.locator('#jobs img, #detail img').count(), 0);
  assert.equal(await page.evaluate(() => window.__panelXss), undefined);
  await noHorizontalOverflow();
  injectName = false;
  await refresh();
  checks.push('task names render as text under the content security policy');

  await clickJob(activeId);
  const cancelButton = page.getByRole('button', { name: '取消任务', exact: true });
  if (publicSettings.capabilities.cancelJobs) {
    await cancelButton.click();
    const dialog = page.getByRole('dialog', { name: '取消任务', exact: true });
    await dialog.waitFor();
    await expectText('dialog[open]', detail.name);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await (await fetch(`${origin}/api/jobs/${activeId}`)).json()).state, 'running');
    await cancelButton.click();
    await page.getByRole('button', { name: '确认取消', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(async ({ origin: base, id }) => {
      const result = await (await fetch(`${base}/api/jobs/${id}`)).json();
      return result.state === 'cancelled';
    }, { origin, id: activeId });
    await expectText('#detail', '已取消');
  } else {
    assert.equal(await cancelButton.isDisabled(), true);
  }
  checks.push('cancellation requires confirmation and only mutates the in-memory demo');

  assert.equal(expectedHttpErrors, 1);
  assert.deepEqual(pageErrors, [], 'No uncaught browser exceptions are expected.');
  assert.deepEqual(consoleErrors, [], 'No unexpected browser console errors are expected.');
  console.log(`Browser regression passed (${checks.length} groups):\n${checks.map((item) => `- ${item}`).join('\n')}`);
  if (screenshots) console.log(`Fictional demo screenshots saved to ${screenshots}`);
} finally {
  await browser?.close();
  await new Promise((resolveClose, rejectClose) => server.close((error) => (
    error ? rejectClose(error) : resolveClose()
  )));
  store.close();
}
