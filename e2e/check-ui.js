import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';
import { createDemoStore } from '../src/data/demo.js';

const config = readConfig({ PANEL_MODE: 'demo', REFRESH_INTERVAL_MS: '1000' }, []);
const store = createDemoStore();
const server = createApp({ config, store });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = `http://127.0.0.1:${server.address().port}`;
const screenshotDirectory = process.env.PANEL_SCREENSHOT_DIR
  ? resolve(process.env.PANEL_SCREENSHOT_DIR)
  : null;

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  const consoleErrors = [];
  let expectedHttpErrorCount = 0;
  let failNextJobsRequest = false;
  let injectName = false;
  let listRequestCount = 0;
  let delayNextDetail = false;
  let announceDelayedRequest;
  let releaseDelayedRequest;
  let announceDelayedResponse;
  const maliciousName = '<img src=x onerror="window.__panelXss = true"> & "quoted"';

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.location().url.endsWith('/api/jobs') && message.text().includes('503')) {
      expectedHttpErrorCount += 1;
      return;
    }
    consoleErrors.push({ text: message.text(), location: message.location() });
  });

  await page.route('**/api/jobs', async (route) => {
    listRequestCount += 1;
    if (failNextJobsRequest) {
      failNextJobsRequest = false;
      await route.fulfill({ status: 503, json: { error: 'Intentional API error for browser regression.' } });
      return;
    }
    const data = store.listJobs();
    if (injectName) data.jobs.find((job) => job.id === 4).name = maliciousName;
    await route.fulfill({ json: data });
  });

  await page.route('**/api/jobs/4', async (route) => {
    const job = store.getJob(4);
    if (injectName) job.name = maliciousName;
    if (!delayNextDetail) {
      await route.fulfill({ json: job });
      return;
    }
    delayNextDetail = false;
    const released = new Promise((resolveRequest) => { releaseDelayedRequest = resolveRequest; });
    announceDelayedRequest();
    await released;
    try {
      await route.fulfill({ json: job });
    } catch (error) {
      // Switching jobs cancels this fetch; a closed request is the expected outcome.
      if (!route.request().failure()) throw error;
    } finally {
      announceDelayedResponse();
    }
  });

  const waitForText = async (selector, text) => {
    await page.waitForFunction(
      ({ selector: target, text: expected }) => document.querySelector(target)?.textContent.includes(expected),
      { selector, text },
    );
  };

  const clickJob = async (id) => {
    await page.locator('#jobs .job').filter({ hasText: `#${id} ·` }).click();
    await waitForText('#detail h2', `#${id} ·`);
  };

  const refresh = async () => {
    await page.locator('#refresh').click();
    await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  };

  const assertNoOverflow = async () => {
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    assert.ok(dimensions.document <= dimensions.viewport + 1, JSON.stringify(dimensions));
    assert.ok(dimensions.body <= dimensions.viewport + 1, JSON.stringify(dimensions));
  };

  await page.goto(address, { waitUntil: 'networkidle' });
  await page.locator('#jobs .job').nth(3).waitFor();
  await clickJob(4);
  await waitForText('#log', '[demo] epoch 48 / batch 80');
  assert.equal(await page.title(), '实验进度');
  assert.equal(await page.locator('#demo-badge').isVisible(), true);
  assert.equal(await page.locator('#jobs .job').count(), 7);
  assert.equal(await page.locator('#workers .worker').count(), 8);
  assert.deepEqual(await page.locator('.metric strong').allTextContents(), ['3', '1', '1', '2']);
  assert.equal(await page.locator('#log-source').inputValue(), 'project-0-train');
  await assertNoOverflow();

  await page.locator('#auto').uncheck();
  assert.equal(await page.locator('#auto').isChecked(), false);
  const requestsWhenPaused = listRequestCount;
  await page.waitForTimeout(config.refreshIntervalMs + 150);
  assert.equal(listRequestCount, requestsWhenPaused, 'Automatic refresh must stop when unchecked.');

  // A page restored from the back/forward cache keeps the existing JS context.
  // Its lifecycle events must not permanently disable the existing refresh timer.
  await page.locator('#auto').check();
  const resumedRefresh = page.waitForRequest(
    (request) => request.url() === `${address}/api/jobs`,
    { timeout: config.refreshIntervalMs * 3 },
  );
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await resumedRefresh;
  await page.locator('#auto').uncheck();
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);

  await page.locator('#search').fill('分类');
  assert.equal(await page.locator('#jobs .job').count(), 1);
  assert.match(await page.locator('#jobs').innerText(), /#3 ·/);
  await page.locator('#state').selectOption('active');
  assert.equal(await page.locator('#jobs .job').count(), 0);
  await waitForText('#jobs .empty', '没有匹配的任务');
  await page.locator('#search').fill('');
  assert.equal(await page.locator('#jobs .job').count(), 3);
  assert.match(await page.locator('#jobs').innerText(), /#4 ·/);
  await page.locator('#state').selectOption('succeeded');
  assert.match(await page.locator('#jobs').innerText(), /#2 ·/);
  await page.locator('#state').selectOption('failed');
  assert.match(await page.locator('#jobs').innerText(), /#1 ·/);
  await page.locator('#state').selectOption('all');
  assert.equal(await page.locator('#jobs .job').count(), 7);

  await page.locator('#log-source').selectOption('attempt-1');
  await waitForText('#log', '[demo] 启动步长1全量训练');
  assert.equal(await page.locator('#follow-log').isChecked(), true);
  await page.locator('#follow-log').uncheck();
  assert.equal(await page.locator('#follow-log').isChecked(), false);
  await page.locator('#follow-log').check();
  assert.equal(await page.locator('#follow-log').isChecked(), true);

  await clickJob(3);
  await waitForText('#log', '尚未生成日志');
  assert.equal(await page.locator('#log-source').isDisabled(), true);
  await clickJob(2);
  await waitForText('#log', '[demo] 退出码 0');
  await page.locator('details[data-section="attempts"] summary').click();
  assert.match(await page.locator('details[data-section="attempts"]').innerText(), /demo-worker-02/);

  const delayedRequestStarted = new Promise((resolveRequest) => { announceDelayedRequest = resolveRequest; });
  const delayedResponseFinished = new Promise((resolveResponse) => { announceDelayedResponse = resolveResponse; });
  delayNextDetail = true;
  await page.locator('#jobs .job').filter({ hasText: '#4 ·' }).click();
  await delayedRequestStarted;
  await clickJob(3);
  releaseDelayedRequest();
  await delayedResponseFinished;
  assert.match(await page.locator('#detail h2').innerText(), /^#3 ·/);
  await waitForText('#log', '尚未生成日志');

  failNextJobsRequest = true;
  await refresh();
  assert.equal(await page.locator('#error').isVisible(), true);
  assert.match(await page.locator('#error').innerText(), /HTTP 503/);
  assert.equal(await page.locator('#jobs .job').count(), 7, 'An API failure must keep the last successful list.');
  await refresh();
  assert.equal(await page.locator('#error').isVisible(), false);

  await clickJob(4);
  await waitForText('#log', '[demo] epoch 48 / batch 80');
  if (screenshotDirectory) {
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDirectory, 'slurm-panel-desktop.png'), fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoOverflow();
  if (screenshotDirectory) {
    await page.screenshot({ path: resolve(screenshotDirectory, 'slurm-panel-mobile.png'), fullPage: true });
  }

  injectName = true;
  await refresh();
  assert.equal(await page.locator('#jobs .job[aria-pressed="true"] .job-name').innerText(), `#4 · ${maliciousName}`);
  assert.equal(await page.locator('#detail h2').innerText(), `#4 · ${maliciousName}`);
  assert.equal(await page.locator('#jobs img, #detail img').count(), 0);
  assert.equal(await page.evaluate(() => window.__panelXss), undefined);
  await assertNoOverflow();

  assert.equal(expectedHttpErrorCount, 1, 'The injected HTTP failure should be the only expected browser error.');
  assert.deepEqual(pageErrors, [], 'No JavaScript exceptions are expected.');
  assert.deepEqual(consoleErrors, [], 'No unexpected console errors are expected.');
  console.log('Browser regression passed: demo, filters, details, logs, cancellation, recovery, XSS and responsive layouts.');
  if (screenshotDirectory) console.log(`Demo screenshots saved to ${screenshotDirectory}`);
} finally {
  await browser?.close();
  await new Promise((resolveClose, rejectClose) => server.close((error) => (
    error ? rejectClose(error) : resolveClose()
  )));
  store.close();
}
