import { el, icon, activeStates, formatDate, formatDuration, formatNumber, progress, stateBadge } from './dom.js';
import { createDetailPanel } from './detail.js';

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  'cluster', 'title', 'demo-badge', 'connection', 'connection-label', 'slurm-link', 'refresh', 'auto', 'auto-label',
  'error', 'metrics', 'range', 'workers', 'workers-summary', 'workers-toggle', 'search', 'sort', 'list-tabs',
  'active-count', 'filter-summary', 'stale-notice', 'stale-text', 'stale-filter', 'jobs', 'job-count',
  'total-count', 'page-prev', 'page-next', 'page-info', 'time-zone-note', 'detail',
].map((id) => [id, $(id)]));

for (const [id, name] of [['refresh', 'refresh'], ['workers-icon', 'chip'], ['workers-toggle', 'chevronUp'], ['search-icon', 'search'], ['stale-icon', 'alert'], ['page-prev', 'arrowLeft'], ['page-next', 'arrowRight']]) {
  $(id).append(icon(name, id === 'stale-icon' ? 17 : 20));
}

let config;
let snapshot;
let selectedId = null;
let selectedGpu = null;
let requestController;
let requestNumber = 0;
let requestPending = false;
let timer;
let searchTimer;
const query = { page: 1, pageSize: 10, q: '', state: 'all', sort: 'active', range: 'all', staleOnly: false };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Accept: 'application/json', ...options.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `读取失败（HTTP ${response.status}）`);
  }
  return response.json();
}

function showError(error) {
  if (error.name === 'AbortError') return;
  elements.error.hidden = false;
  elements.error.textContent = `${error.message}。${snapshot ? '已保留上次成功读取的数据。' : ''}`;
}

const detail = createDetailPanel({
  container: elements.detail,
  getConfig: () => config,
  getSnapshot: () => snapshot,
  api,
  onRefresh: () => refresh(),
  onError: showError,
});

function setConnection(connected) {
  elements.connection.className = `connection ${connected ? 'connected' : 'disconnected'}`;
  elements['connection-label'].textContent = connected ? '连接正常' : '连接异常';
  elements.connection.title = snapshot ? `最近成功读取：${formatDate(snapshot.now, config)}` : '';
}

function configure(next) {
  config = next;
  document.title = config.title;
  elements.title.textContent = config.title;
  elements.cluster.textContent = config.clusterName;
  elements['demo-badge'].hidden = config.mode !== 'demo';
  elements['auto-label'].textContent = `自动刷新 ${formatNumber(config.refreshIntervalMs / 1000)}s`;
  elements['time-zone-note'].textContent = `时间：${config.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  if (config.slurmWebUrl) {
    const url = new URL(config.slurmWebUrl);
    if (['https:', 'http:'].includes(url.protocol)) {
      elements['slurm-link'].href = url.href;
      elements['slurm-link'].hidden = false;
    }
  }
  clearInterval(timer);
  timer = setInterval(() => { if (elements.auto.checked) refresh({ replace: false }); }, config.refreshIntervalMs);
}

function selectJob(id, gpu = null) {
  selectedId = id;
  selectedGpu = gpu ?? snapshot?.workers.find((worker) => worker.job_ids.includes(id))?.gpu ?? null;
  renderJobs();
  renderWorkers();
  detail.select(id).catch(showError);
}

function renderMetrics() {
  const definitions = [
    ['active', '运行中', 'play'], ['queued', '排队中', 'clock'],
    ['succeeded', '已完成', 'check'], ['failed', '失败', 'close'], ['cancelled', '已取消', 'slash'],
  ];
  elements.metrics.replaceChildren(...definitions.map(([state, label, symbol]) => {
    const card = el('button', `metric ${state}`);
    card.type = 'button';
    card.dataset.state = state;
    card.setAttribute('aria-label', `${label} ${snapshot.summary[state]}`);
    card.setAttribute('aria-pressed', String(query.state === state));
    const artwork = el('span', 'metric-icon');
    artwork.append(icon(symbol, 24));
    const content = el('span', 'metric-value');
    content.append(el('span', 'metric-label', label), el('strong', null, formatNumber(snapshot.summary[state], 0)));
    card.append(artwork, content);
    card.addEventListener('click', () => updateQuery({ state, staleOnly: false }));
    return card;
  }));
  elements['active-count'].textContent = formatNumber(snapshot.summary.active, 0);
}

function renderWorkers() {
  const busy = snapshot.workers.filter((worker) => worker.state === 'running').length;
  const idle = snapshot.workers.filter((worker) => worker.state === 'idle').length;
  const unknown = snapshot.workers.length - busy - idle;
  elements['workers-summary'].textContent = `${snapshot.workers.length} 个执行器 · ${busy} 执行中 · ${idle} 待命${unknown ? ` · ${unknown} 状态未知` : ''}`;
  elements.workers.replaceChildren(...snapshot.workers.map((worker) => {
    const current = worker.gpu === selectedGpu;
    const item = el('article', `worker${current ? ' selected' : ''}`);
    item.dataset.gpu = worker.gpu;
    const heading = el('div', 'worker-heading');
    const state = el('span', worker.state === 'running' ? 'worker-state busy' : 'worker-state');
    const stateLabel = { running: '执行中', idle: '待命', unknown: '状态未知' };
    state.append(el('span', 'status-dot'), document.createTextNode(stateLabel[worker.state]));
    heading.append(el('strong', null, `GPU ${worker.gpu}`), state);
    item.append(heading, el('span', 'worker-slurm', `Job #${worker.slurm_job_id}`));
    for (const id of worker.job_ids) {
      const job = el('button', 'worker-job', `任务 #${id}`);
      job.type = 'button';
      job.setAttribute('aria-label', `查看任务 #${id}`);
      job.addEventListener('click', () => selectJob(id, worker.gpu));
      item.append(job);
    }
    item.title = `队列心跳：${formatDate(worker.heartbeat, config)}`;
    return item;
  }));
  if (!snapshot.workers.length) elements.workers.append(el('p', 'empty', '尚无执行器记录'));
}

function renderProgress(job) {
  const telemetry = job.telemetry;
  const content = el('span', 'job-progress');
  const tags = el('span', 'job-tags');
  for (const label of job.tags) tags.append(el('span', 'tag', label));
  if (tags.childNodes.length) content.append(tags);
  if (telemetry?.total_epochs != null && telemetry.epoch != null) {
    content.append(el('span', 'job-progress-caption', `${formatNumber(telemetry.epoch, 0)} / ${formatNumber(telemetry.total_epochs, 0)} epochs`));
  } else if (telemetry?.updates != null) {
    content.append(el('span', 'job-progress-caption', `${formatNumber(telemetry.updates, 0)} 步`));
  }
  if (telemetry?.percent != null) {
    const line = el('span', 'job-progress-line');
    const bar = progress(telemetry.percent);
    bar.setAttribute('aria-label', telemetry.percent_kind === 'budget' ? '脚本报告的训练预算进度' : '脚本报告的训练进度');
    line.append(bar, el('span', 'job-percent', `${telemetry.percent_kind === 'budget' ? '预算 ' : ''}${formatNumber(telemetry.percent, 0)}%`));
    if (telemetry.percent_kind === 'budget') line.title = '百分比为训练预算进度';
    content.append(line);
  } else if (job.tags.length === 0) content.append(el('span', 'muted', '未报告进度'));
  return content;
}

function renderJob(job) {
  const row = el('button', `job${selectedId === job.id ? ' selected' : ''}`);
  row.type = 'button';
  row.dataset.id = job.id;
  row.setAttribute('aria-pressed', String(selectedId === job.id));
  const info = el('span', 'job-info');
  const heading = el('span', 'job-heading');
  heading.append(el('span', 'job-id', `#${job.id}`), el('span', 'job-name', job.name));
  info.append(heading);
  const attempt = job.attempt;
  const parts = [];
  if (attempt) parts.push(`GPU ${attempt.gpu}`);
  if (job.telemetry?.updates != null && !activeStates.has(job.state)) parts.push(`${formatNumber(job.telemetry.updates, 0)} 步`);
  if (attempt?.started) parts.push(formatDuration((attempt.finished ?? snapshot.now) - attempt.started));
  else parts.push('尚未开始');
  info.append(el('span', 'job-meta', parts.join(' · ')));
  if (job.stale) {
    const stale = el('span', 'job-stale');
    stale.append(icon('alert', 14), document.createTextNode(`${Math.floor(job.stale_seconds / 60)} 分钟未更新`));
    info.append(stale);
  }
  row.append(info, renderProgress(job));
  const status = el('span', 'job-status');
  status.append(stateBadge(job.state, job.stale));
  row.append(status);
  if (['failed', 'oom'].includes(job.state)) {
    const actualMessage = job.attempt?.message || job.message;
    if (actualMessage) {
      const error = el('span', 'job-failure');
      error.append(icon('close', 13), document.createTextNode(actualMessage));
      row.append(error);
    }
  }
  row.addEventListener('click', () => selectJob(job.id, attempt?.gpu));
  return row;
}

function renderJobs() {
  if (!snapshot) return;
  elements.jobs.replaceChildren(...(snapshot.jobs.length ? snapshot.jobs.map(renderJob) : [el('p', 'empty', '没有匹配的任务')]));
  const page = snapshot.pagination;
  elements['job-count'].textContent = formatNumber(page.total, 0);
  elements['total-count'].textContent = `共 ${formatNumber(page.total, 0)} 个实验`;
  elements['page-info'].textContent = `${page.page} / ${page.totalPages}`;
  elements['page-prev'].disabled = page.page <= 1;
  elements['page-next'].disabled = page.page >= page.totalPages;
  for (const tab of elements['list-tabs'].querySelectorAll('button')) {
    const selected = tab.dataset.state === query.state && !query.staleOnly;
    tab.setAttribute('aria-selected', String(selected));
    const outsideTabs = !['all', 'active', 'failed'].includes(query.state) || query.staleOnly;
    tab.tabIndex = selected || (outsideTabs && tab.dataset.state === 'all') ? 0 : -1;
  }
  const extraFilter = !['all', 'active', 'failed'].includes(query.state) || query.staleOnly;
  elements['filter-summary'].hidden = !extraFilter;
  if (extraFilter) {
    const labels = { queued: '排队中', succeeded: '已完成', cancelled: '已取消' };
    elements['filter-summary'].replaceChildren(document.createTextNode(query.staleOnly ? '正在查看长时间未更新的任务' : `当前筛选：${labels[query.state]}`));
    const reset = el('button', 'text-button', '清除筛选');
    reset.type = 'button';
    reset.addEventListener('click', () => updateQuery({ state: 'all', staleOnly: false }));
    elements['filter-summary'].append(reset);
  }
  elements['stale-notice'].hidden = !snapshot.summary.stale;
  elements['stale-text'].textContent = `${snapshot.summary.stale} 个任务超过 10 分钟未更新进度`;
  elements['stale-filter'].textContent = query.staleOnly ? '查看全部' : '查看';
}

async function refresh({ replace = true } = {}) {
  if (requestPending && !replace) return;
  requestPending = true;
  requestController?.abort();
  requestController = new AbortController();
  const sequence = ++requestNumber;
  elements.refresh.classList.add('spinning');
  elements.jobs.setAttribute('aria-busy', 'true');
  try {
    if (!config) configure(await api('/api/config', { signal: requestController.signal }));
    const search = new URLSearchParams({ ...query, staleOnly: query.staleOnly ? '1' : '0' });
    const next = await api(`/api/jobs?${search}`, { signal: requestController.signal });
    if (sequence !== requestNumber) return;
    snapshot = next;
    query.page = next.pagination.page;
    elements.error.hidden = true;
    setConnection(true);
    renderMetrics();
    let needsSelection = false;
    if (selectedId === null) {
      const selection = snapshot.jobs.find((job) => activeStates.has(job.state) && !job.stale)
        ?? snapshot.jobs.find((job) => activeStates.has(job.state)) ?? snapshot.jobs[0];
      if (selection) {
        selectedId = selection.id;
        selectedGpu = selection.attempt?.gpu ?? null;
        needsSelection = true;
      }
    } else {
      selectedGpu = snapshot.workers.find((worker) => worker.job_ids.includes(selectedId))?.gpu
        ?? snapshot.jobs.find((job) => job.id === selectedId)?.attempt?.gpu ?? selectedGpu;
    }
    renderWorkers();
    renderJobs();
    if (selectedId !== null) {
      if (needsSelection) await detail.select(selectedId);
      else await detail.refresh();
    }
  } catch (error) {
    if (sequence === requestNumber && error.name !== 'AbortError') {
      setConnection(false);
      showError(error);
    }
  } finally {
    if (sequence === requestNumber) {
      requestPending = false;
      elements.refresh.classList.remove('spinning');
      elements.jobs.setAttribute('aria-busy', 'false');
    }
  }
}

function updateQuery(changes) {
  Object.assign(query, changes, { page: changes.page ?? 1 });
  refresh();
}

elements.refresh.addEventListener('click', () => refresh());
elements.range.addEventListener('change', () => updateQuery({ range: elements.range.value }));
elements.sort.addEventListener('change', () => updateQuery({ sort: elements.sort.value }));
elements.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => updateQuery({ q: elements.search.value.trim() }), 180);
});
elements['list-tabs'].addEventListener('click', (event) => {
  const button = event.target.closest('button[data-state]');
  if (button) updateQuery({ state: button.dataset.state, staleOnly: false });
});
elements['list-tabs'].addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...elements['list-tabs'].querySelectorAll('button')];
  const current = tabs.indexOf(event.target);
  if (current < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  updateQuery({ state: tabs[next].dataset.state, staleOnly: false });
});
elements['stale-filter'].addEventListener('click', () => {
  const enabled = !query.staleOnly;
  clearTimeout(searchTimer);
  elements.search.value = '';
  selectedId = null;
  selectedGpu = null;
  updateQuery({ staleOnly: enabled, state: 'all', q: '' });
});
elements['page-prev'].addEventListener('click', () => updateQuery({ page: query.page - 1 }));
elements['page-next'].addEventListener('click', () => updateQuery({ page: query.page + 1 }));
elements['workers-toggle'].addEventListener('click', () => {
  const collapsed = !elements.workers.hidden;
  elements.workers.hidden = collapsed;
  elements['workers-toggle'].setAttribute('aria-expanded', String(!collapsed));
  elements['workers-toggle'].setAttribute('aria-label', `${collapsed ? '展开' : '收起'} GPU 执行器`);
  elements['workers-toggle'].replaceChildren(icon(collapsed ? 'chevronDown' : 'chevronUp'));
});

refresh();
