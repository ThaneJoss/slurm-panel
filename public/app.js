const elements = Object.fromEntries(
  [
    'title', 'demo-badge', 'slurm-link', 'refresh', 'auto', 'auto-label',
    'error', 'metrics', 'updated', 'workers', 'search', 'state', 'jobs',
    'job-count', 'detail', 'time-zone-note',
  ].map((id) => [id, document.getElementById(id)]),
);

const statusNames = {
  running: '运行中',
  assigned: '已分配',
  launching: '启动中',
  starting: '初始化',
  queued: '排队中',
  waiting_resources: '等待资源',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  oom: '显存不足',
};

const activeStates = new Set(['assigned', 'launching', 'starting', 'running']);
const queuedStates = new Set(['queued', 'waiting_resources']);
const failedStates = new Set(['failed', 'cancelled', 'oom']);

let config = null;
let snapshot = null;
let selectedId = null;
let selectedLogKey = null;
let followLog = true;
let refreshing = false;
let refreshTimer = null;
let detailController = null;
let logController = null;
let detailRequest = 0;
let logRequest = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function badge(status) {
  const node = element('span', 'badge', statusNames[status] ?? status);
  if (activeStates.has(status)) node.classList.add('active');
  else if (queuedStates.has(status)) node.classList.add('queued');
  else if (failedStates.has(status)) node.classList.add('failed');
  else if (status === 'succeeded') node.classList.add('succeeded');
  return node;
}

function number(value, digits = 2) {
  if (value == null) return '—';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function date(value, timeOnly = false) {
  if (value == null || value === 0) return '—';
  const parsed = new Date(typeof value === 'number' ? value * 1000 : value);
  if (Number.isNaN(parsed.getTime())) return '—';
  const options = { hour12: false };
  if (config?.timeZone) options.timeZone = config.timeZone;
  return timeOnly
    ? parsed.toLocaleTimeString('zh-CN', options)
    : parsed.toLocaleString('zh-CN', options);
}

function duration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 3600)}时 ${Math.floor((total % 3600) / 60)}分`;
}

async function api(path, signal) {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
  return response.json();
}

function showError(error) {
  if (error.name === 'AbortError') return;
  elements.error.hidden = false;
  elements.error.textContent = snapshot
    ? `${error.message}。已保留上次成功读取的数据，可点击“立即刷新”重试。`
    : `${error.message}。请点击“立即刷新”重试。`;
}

function configure(nextConfig) {
  config = nextConfig;
  document.title = config.title;
  elements.title.textContent = config.title;
  elements['demo-badge'].hidden = config.mode !== 'demo';
  elements['auto-label'].textContent = `每 ${number(config.refreshIntervalMs / 1000)} 秒刷新`;
  elements['time-zone-note'].textContent = config.timeZone
    ? `时间使用 ${config.timeZone} 时区。`
    : `时间使用浏览器所在时区（${Intl.DateTimeFormat().resolvedOptions().timeZone}）。`;

  if (config.slurmWebUrl) {
    const url = new URL(config.slurmWebUrl, window.location.origin);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      elements['slurm-link'].href = url.href;
      elements['slurm-link'].hidden = false;
    }
  }

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (elements.auto.checked) refresh();
  }, config.refreshIntervalMs);
}

function renderMetrics() {
  const counts = snapshot.counts;
  const sum = (states) => [...states].reduce((total, state) => total + (counts[state] ?? 0), 0);
  const metrics = [
    ['运行中', sum(activeStates)],
    ['排队 / 等待资源', sum(queuedStates)],
    ['已完成', counts.succeeded ?? 0],
    ['失败 / 已取消', sum(failedStates)],
  ];
  elements.metrics.replaceChildren(...metrics.map(([name, value]) => {
    const item = element('div', 'metric card');
    item.append(element('span', null, name), element('strong', null, number(value, 0)));
    return item;
  }));
}

function renderWorkers() {
  elements.updated.textContent = [
    snapshot.paused ? '已暂停派发' : '正在派发',
    `调度心跳 ${date(snapshot.manager_heartbeat)}`,
    `页面更新 ${date(snapshot.now)}`,
  ].join(' · ');

  const workers = snapshot.workers.map((worker) => {
    const count = snapshot.jobs.filter((job) => (
      activeStates.has(job.state) && job.attempt?.gpu === worker.gpu
    )).length;
    const item = element('div', 'worker');
    item.append(
      element('b', null, `GPU ${worker.gpu}`),
      element('span', null, `Slurm ${worker.slurm_job_id ?? '—'}`),
      element('span', null, `当前列表 ${count} 个活跃实验`),
      element('span', null, `心跳 ${date(worker.heartbeat, true)}`),
    );
    return item;
  });
  elements.workers.replaceChildren(...(
    workers.length ? workers : [element('p', 'empty', '尚无消费者记录')]
  ));
}

function matchesFilter(job) {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const matchesQuery = String(job.name).toLocaleLowerCase().includes(query)
    || String(job.id).includes(query);
  const filter = elements.state.value;
  const matchesState = filter === 'all'
    || (filter === 'active' && activeStates.has(job.state))
    || (filter === 'queued' && queuedStates.has(job.state))
    || (filter === 'failed' && failedStates.has(job.state))
    || job.state === filter;
  return matchesQuery && matchesState;
}

function renderJob(job) {
  const item = element('button', 'job');
  item.type = 'button';
  item.setAttribute('aria-pressed', String(selectedId === job.id));
  if (selectedId === job.id) item.classList.add('selected');

  const title = element('span', 'job-title');
  title.append(element('span', 'job-name', `#${job.id} · ${job.name}`), badge(job.state));
  item.append(title);

  const attempt = job.attempt;
  const telemetry = job.telemetry;
  const started = attempt?.started ?? attempt?.created;
  let meta = attempt
    ? `GPU ${attempt.gpu} · 尝试 ${attempt.number} · ${duration((attempt.finished ?? snapshot.now) - started)}`
    : '尚未开始';
  if (telemetry?.updates != null) meta += ` · ${number(telemetry.updates, 0)} 步`;
  item.append(element('span', 'job-meta', meta));

  if (telemetry?.percent != null && Number.isFinite(Number(telemetry.percent))) {
    const progress = element('progress', 'progress');
    progress.max = 100;
    progress.value = Math.min(100, Math.max(0, Number(telemetry.percent)));
    progress.setAttribute('aria-label', '脚本报告的训练预算进度');
    item.append(progress, element('span', 'job-meta', `训练预算 ${number(telemetry.percent)}%`));
  }

  item.addEventListener('click', () => {
    if (selectedId === job.id) return;
    selectedId = job.id;
    selectedLogKey = null;
    detailController?.abort();
    logController?.abort();
    renderJobs();
    elements.detail.replaceChildren(element('p', 'empty', '正在读取任务详情…'));
    loadDetail().catch(showError);
  });
  return item;
}

function renderJobs() {
  const jobs = snapshot.jobs.filter(matchesFilter);
  elements['job-count'].textContent = `${jobs.length} / ${snapshot.jobs.length}`;
  elements.jobs.setAttribute('aria-busy', 'false');
  elements.jobs.replaceChildren(...(
    jobs.length
      ? jobs.map(renderJob)
      : [element('p', 'empty', snapshot.jobs.length ? '没有匹配的任务' : '队列中还没有任务')]
  ));
}

function fact(name, value) {
  const node = element('div', 'fact');
  node.append(element('dt', null, name), element('dd', null, value));
  return node;
}

function disclosure(key, title, content, opened) {
  const node = element('details');
  node.dataset.section = key;
  node.open = opened;
  node.append(element('summary', null, title), content);
  return node;
}

function renderAttempts(attempts) {
  const list = element('div');
  if (!attempts.length) list.append(element('p', 'muted', '尚无尝试记录'));
  for (const attempt of attempts) {
    const item = element('div', 'attempt');
    item.append(
      element('span', null, `第 ${attempt.number} 次 · GPU ${attempt.gpu} · Slurm ${attempt.slurm_job_id ?? '—'} · `),
      badge(attempt.state),
      element('p', null, `${date(attempt.started)} → ${date(attempt.finished)} · 退出码 ${attempt.exit_code ?? '—'}`),
    );
    list.append(item);
  }
  return list;
}

function renderDetail(job) {
  const openSections = new Set(
    [...elements.detail.querySelectorAll('details[open]')].map((node) => node.dataset.section),
  );
  const telemetry = job.telemetry;
  const attempt = job.attempt;
  const fragments = [element('h2', null, `#${job.id} · ${job.name}`), badge(job.state)];
  const facts = element('dl', 'facts');
  facts.append(
    fact('开始时间', date(attempt?.started)),
    fact('本次运行时长', attempt?.started != null
      ? duration((attempt.finished ?? snapshot.now) - attempt.started)
      : '尚未开始'),
    fact('当前阶段', telemetry?.phase ?? statusNames[job.state] ?? job.state),
    fact('Epoch / Batch', telemetry
      ? `${telemetry.epoch ?? '—'} / ${telemetry.batch ?? '—'}${telemetry.batches != null ? ` / ${telemetry.batches}` : ''}`
      : '未报告'),
    fact('累计更新步数', number(telemetry?.updates, 0)),
    fact('训练损失', telemetry?.loss != null ? number(telemetry.loss, 5) : '未报告'),
    fact('脚本报告吞吐', telemetry?.images_per_second != null
      ? `${number(telemetry.images_per_second)} 图/秒`
      : '未报告'),
    fact('脚本报告的预算结束', date(telemetry?.budget_end)),
  );
  fragments.push(facts);

  if (telemetry) {
    const source = element('p', 'source');
    source.append(
      element('span', null, `进度更新时间：${date(telemetry.updated)}`),
      element('br'),
      document.createTextNode(telemetry.source ?? '—'),
    );
    fragments.push(source);
  }

  fragments.push(
    disclosure(
      'command',
      '命令与工作目录',
      element('pre', null, `${job.cwd}\n${job.argv.join(' ')}`),
      openSections.has('command'),
    ),
    disclosure(
      'attempts',
      `尝试记录（${job.attempts.length}）`,
      renderAttempts(job.attempts),
      openSections.has('attempts'),
    ),
  );

  const toolbar = element('div', 'log-toolbar');
  const select = element('select');
  select.id = 'log-source';
  select.setAttribute('aria-label', '日志来源');
  select.disabled = !job.logs.length;
  for (const log of job.logs) {
    const option = element('option', null, log.label);
    option.value = log.key;
    option.selected = log.key === selectedLogKey;
    select.append(option);
  }
  if (!job.logs.length) select.append(element('option', null, '尚无日志来源'));
  select.addEventListener('change', () => {
    selectedLogKey = select.value;
    document.getElementById('log').textContent = '正在读取日志…';
    document.getElementById('log-updated').textContent = '';
    loadLog(job.id, selectedLogKey).catch(showError);
  });

  const followLabel = element('label', 'checkbox-label');
  const followInput = element('input');
  followInput.id = 'follow-log';
  followInput.type = 'checkbox';
  followInput.checked = followLog;
  followInput.addEventListener('change', () => {
    followLog = followInput.checked;
    if (followLog) {
      const log = document.getElementById('log');
      log.scrollTop = log.scrollHeight;
    }
  });
  followLabel.append(followInput, document.createTextNode('跟随日志'));
  const updated = element('span', 'source');
  updated.id = 'log-updated';
  toolbar.append(select, followLabel, updated);

  const log = element('pre', 'log', job.logs.length ? '正在读取日志…' : '尚未生成日志');
  log.id = 'log';
  log.tabIndex = 0;
  log.setAttribute('aria-label', '日志内容');
  fragments.push(toolbar, log);
  elements.detail.replaceChildren(...fragments);
}

async function loadLog(jobId, key, previousScroll = null) {
  if (!key) return;
  logController?.abort();
  logController = new AbortController();
  const request = ++logRequest;
  const result = await api(
    `/api/jobs/${jobId}/logs/${encodeURIComponent(key)}`,
    logController.signal,
  );
  if (request !== logRequest || jobId !== selectedId || key !== selectedLogKey) return;
  const log = document.getElementById('log');
  log.textContent = result.text || '日志文件尚无输出';
  document.getElementById('log-updated').textContent = date(result.updated, true);
  log.scrollTop = followLog ? log.scrollHeight : (previousScroll ?? 0);
}

async function loadDetail() {
  if (selectedId == null) return;
  detailController?.abort();
  detailController = new AbortController();
  const request = ++detailRequest;
  const jobId = selectedId;
  elements.detail.setAttribute('aria-busy', 'true');
  try {
    const job = await api(`/api/jobs/${jobId}`, detailController.signal);
    if (request !== detailRequest || selectedId !== jobId) return;
    const previousKey = selectedLogKey;
    const previousScroll = document.getElementById('log')?.scrollTop ?? null;
    const previousText = document.getElementById('log')?.textContent ?? null;
    const previousUpdated = document.getElementById('log-updated')?.textContent ?? '';
    if (!job.logs.some((log) => log.key === selectedLogKey)) {
      selectedLogKey = job.logs.find((log) => log.key.startsWith('project-'))?.key
        ?? job.logs[0]?.key
        ?? null;
    }
    renderDetail(job);
    // Keep the last successful log visible while its next request is in flight.
    if (previousKey === selectedLogKey && previousText != null) {
      const log = document.getElementById('log');
      log.textContent = previousText;
      log.scrollTop = followLog ? log.scrollHeight : (previousScroll ?? 0);
      document.getElementById('log-updated').textContent = previousUpdated;
    }
    await loadLog(jobId, selectedLogKey, previousKey === selectedLogKey ? previousScroll : null);
  } finally {
    if (request === detailRequest) elements.detail.setAttribute('aria-busy', 'false');
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  elements.refresh.textContent = '正在刷新…';
  try {
    if (!config) configure(await api('/api/config'));
    snapshot = await api('/api/jobs');
    elements.error.hidden = true;
    renderMetrics();
    renderWorkers();
    if (!snapshot.jobs.length) {
      selectedId = null;
      selectedLogKey = null;
      detailController?.abort();
      logController?.abort();
    } else if (selectedId == null) {
      selectedId = (snapshot.jobs.find((job) => activeStates.has(job.state)) ?? snapshot.jobs[0])?.id ?? null;
    }
    renderJobs();
    if (selectedId == null) {
      elements.detail.replaceChildren(element('p', 'empty', '选择一个任务，查看进度与日志'));
    } else {
      await loadDetail();
    }
  } catch (error) {
    showError(error);
  } finally {
    refreshing = false;
    elements.refresh.disabled = false;
    elements.refresh.textContent = '立即刷新';
    elements.jobs.setAttribute('aria-busy', 'false');
  }
}

elements.refresh.addEventListener('click', refresh);
elements.search.addEventListener('input', () => snapshot && renderJobs());
elements.state.addEventListener('change', () => snapshot && renderJobs());
refresh();
