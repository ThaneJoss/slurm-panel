import {
  el, icon, formatNumber, formatDuration, formatDate, stateBadge, progress, copyText,
} from './dom.js';

const tabs = [
  ['overview', '概览'],
  ['logs', '日志'],
  ['config', '配置'],
  ['history', '运行记录'],
];
const cancellableStates = new Set(['queued', 'waiting_resources', 'assigned', 'launching', 'starting', 'running']);

function button(label, symbol, className = 'button') {
  const node = el('button', className);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  node.title = label;
  if (symbol) node.append(icon(symbol));
  node.append(el('span', null, label));
  return node;
}

function iconButton(label, symbol) {
  const node = button(label, symbol, 'icon-button');
  node.classList.add('detail-icon-button');
  return node;
}

function disabledAction(node, reason) {
  node.disabled = true;
  node.title = reason;
  return node;
}

function bytes(value) {
  if (value == null) return '—';
  if (value >= 1024 ** 3) return `${formatNumber(value / 1024 ** 3, 1)} GiB`;
  if (value >= 1024 ** 2) return `${formatNumber(value / 1024 ** 2, 1)} MiB`;
  if (value >= 1024) return `${formatNumber(value / 1024, 1)} KiB`;
  return `${formatNumber(value, 0)} B`;
}

/** Owns detail state independently of list filters and automatic list refreshes. */
export function createDetailPanel({ container, getConfig, getSnapshot, api, onRefresh, onError }) {
  let selectedId = null;
  let job = null;
  let activeTab = 'overview';
  let logKey = null;
  let follow = true;
  let lastLog = null;
  let detailController = null;
  let logController = null;
  let detailSequence = 0;
  let logSequence = 0;
  let activeDialog = null;
  let announcement = '';
  const pendingCancellations = new Set();

  function report(error) {
    if (error.name !== 'AbortError') onError(error);
  }

  function config() {
    return getConfig();
  }

  function now() {
    return getSnapshot()?.now ?? Date.now() / 1000;
  }

  function elapsed(attempt) {
    return attempt?.started == null ? null : (attempt.finished ?? now()) - attempt.started;
  }

  function announce(message) {
    announcement = message;
    const status = container.querySelector('.detail-announcement');
    if (status) status.textContent = message;
  }

  function visibleConfiguration() {
    return {
      id: job.id,
      name: job.name,
      cwd: job.cwd,
      argv: job.argv,
      tags: job.tags ?? [],
      state: job.state,
      attempt: job.attempt ? {
        number: job.attempt.number,
        gpu: job.attempt.gpu,
        slurm_job_id: job.attempt.slurm_job_id,
      } : null,
    };
  }

  async function copy(value, message) {
    try {
      await copyText(value);
      announce(message);
    } catch (error) {
      report(error);
    }
  }

  function openDialog(title) {
    activeDialog?.close();
    const dialog = el('dialog', 'detail-dialog');
    const heading = el('div', 'detail-dialog-heading');
    const id = `detail-dialog-title-${selectedId}`;
    const titleNode = el('h2', null, title);
    titleNode.id = id;
    dialog.setAttribute('aria-labelledby', id);
    const close = iconButton('关闭对话框', 'close');
    close.addEventListener('click', () => dialog.close());
    heading.append(titleNode, close);
    const content = el('div', 'detail-dialog-content');
    dialog.append(heading, content);
    dialog.addEventListener('close', () => {
      if (activeDialog === dialog) activeDialog = null;
      dialog.remove();
    });
    document.body.append(dialog);
    activeDialog = dialog;
    dialog.showModal();
    return { dialog, content };
  }

  function showInformation() {
    const { content } = openDialog('任务信息');
    content.append(el('p', 'dialog-job-name', `#${job.id} · ${job.name}`));
    const facts = el('dl', 'detail-fact-list');
    for (const [name, value] of [
      ['创建时间', formatDate(job.created, config())],
      ['队列更新时间', formatDate(job.updated, config())],
      [job.telemetry?.updated_source === 'observed' ? '面板观察进度时间' : '进度更新时间', formatDate(job.telemetry?.updated, config())],
      ['队列消息', job.message || '无'],
      ['进度来源', job.telemetry?.source ?? '尚未报告'],
    ]) {
      facts.append(el('dt', null, name), el('dd', null, value));
    }
    content.append(facts);
  }

  async function showArtifacts() {
    const id = selectedId;
    const { dialog, content } = openDialog('任务产物');
    content.append(el('p', 'dialog-job-name', `#${job.id} · ${job.name}`));
    const result = el('div', 'artifact-result', '正在读取产物…');
    content.append(result);
    const controller = new AbortController();
    dialog.addEventListener('close', () => controller.abort(), { once: true });
    try {
      const data = await api(`/api/jobs/${id}/artifacts`, { signal: controller.signal });
      if (!dialog.open) return;
      const nodes = [];
      if (data.directories.length) {
        const directories = el('ul', 'artifact-directories');
        for (const directory of data.directories) directories.append(el('li', null, directory));
        nodes.push(el('h3', null, '输出目录'), directories);
      }
      if (data.files.length) {
        const files = el('ul', 'artifact-files');
        for (const file of data.files) {
          const item = el('li');
          const description = el('div');
          description.append(
            el('strong', null, file.name),
            el('span', 'artifact-path', file.path),
            el('small', 'muted', `${bytes(file.size)} · ${formatDate(file.modified, config())}`),
          );
          const copyPath = iconButton(`复制产物路径 ${file.name}`, 'copy');
          copyPath.addEventListener('click', () => copy(file.path, '产物路径已复制。'));
          item.append(description, copyPath);
          files.append(item);
        }
        nodes.push(el('h3', null, `产物文件 · ${data.files.length}`), files);
      } else {
        nodes.push(el('p', 'detail-empty', '输出目录中尚无可展示的产物文件。'));
      }
      if (data.truncated) nodes.push(el('p', 'detail-notice', '文件较多，仅展示前 200 项。'));
      nodes.push(el('p', 'muted', '这里展示服务端产物的路径和文件信息，可复制路径后在服务器中查看。'));
      result.replaceChildren(...nodes);
    } catch (error) {
      if (error.name === 'AbortError') return;
      result.replaceChildren(el('p', 'detail-notice is-error', error.message));
      report(error);
    }
  }

  function showCancellation() {
    const id = selectedId;
    const name = job.name;
    const { dialog, content } = openDialog('取消任务');
    content.append(
      el('p', 'dialog-job-name', `#${id} · ${name}`),
      el('p', null, config().mode === 'demo'
        ? '确认取消这个演示任务？操作只更新虚构数据。'
        : '确认向队列提交此任务的取消请求？'),
    );
    let token = null;
    if (config().capabilities?.cancellationRequiresToken) {
      const label = el('label', 'cancel-token-label', '操作令牌');
      token = el('input', 'cancel-token');
      token.type = 'password';
      token.autocomplete = 'off';
      token.id = 'cancel-token';
      label.htmlFor = token.id;
      token.placeholder = '输入当前操作使用的令牌';
      content.append(label, token);
    }
    const result = el('p', 'cancel-result');
    result.setAttribute('role', 'status');
    const actions = el('div', 'detail-dialog-actions');
    const keep = button('保留任务', null, 'button');
    keep.addEventListener('click', () => dialog.close());
    const confirm = button('确认取消', 'trash', 'button danger');
    actions.append(keep, confirm);
    content.append(result, actions);
    dialog.addEventListener('close', () => {
      if (token) token.value = '';
    }, { once: true });
    confirm.addEventListener('click', async () => {
      if (token && !token.value.trim()) {
        result.textContent = '请输入操作令牌。';
        token.focus();
        return;
      }
      confirm.disabled = true;
      keep.disabled = true;
      result.textContent = '正在提交取消请求…';
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token.value}`;
      try {
        const response = await api(`/api/jobs/${id}/cancel`, { method: 'POST', headers, body: '{}' });
        if (response.state === 'cancellation_requested') pendingCancellations.add(id);
        announce(response.state === 'cancelled'
          ? `演示任务 #${id} 已取消。`
          : `任务 #${id} 的取消请求已提交，等待队列更新。`);
        dialog.close();
        if (selectedId === id) render();
        await onRefresh();
      } catch (error) {
        result.textContent = error.message;
        confirm.disabled = false;
        keep.disabled = false;
        report(error);
      } finally {
        if (token) token.value = '';
      }
    });
    token?.focus();
  }

  function renderHeader() {
    const header = el('header', 'detail-header');
    const top = el('div', 'detail-heading');
    const title = el('h2', null, `#${job.id} · ${job.name}`);
    const more = iconButton('查看任务信息', 'more');
    more.dataset.focusKey = 'more';
    more.addEventListener('click', showInformation);
    top.append(title, more);
    const chips = el('div', 'detail-chips');
    chips.append(stateBadge(job.state, job.stale));
    if (job.attempt) {
      for (const text of [`GPU ${job.attempt.gpu}`, `Job #${job.attempt.slurm_job_id}`, `第 ${job.attempt.number} 次运行`]) {
        chips.append(el('span', 'detail-chip', text));
      }
    }
    header.append(top, chips);
    return header;
  }

  function switchTab(next) {
    activeTab = next;
    render();
    loadLog().catch(report);
  }

  function renderTabs() {
    const list = el('div', 'detail-tabs');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', '任务详情');
    tabs.forEach(([value, name], index) => {
      const tab = el('button', `detail-tab${activeTab === value ? ' is-active' : ''}`, name);
      tab.type = 'button';
      tab.id = `detail-tab-${value}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(activeTab === value));
      tab.setAttribute('aria-controls', 'detail-panel');
      tab.tabIndex = activeTab === value ? 0 : -1;
      tab.dataset.focusKey = `tab-${value}`;
      tab.addEventListener('click', () => switchTab(value));
      tab.addEventListener('keydown', (event) => {
        let next = null;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        switchTab(tabs[next][0]);
        container.querySelector(`#detail-tab-${tabs[next][0]}`).focus();
      });
      list.append(tab);
    });
    return list;
  }

  function progressCard() {
    const telemetry = job.telemetry;
    const section = el('section', 'detail-section progress-card');
    section.append(el('h3', null, telemetry?.percent_kind === 'budget' ? '训练预算进度' : '训练进度'));
    const statistics = el('div', 'detail-progress-statistics');
    const value = el('div', 'detail-progress-value');
    if (telemetry?.epoch != null && telemetry.total_epochs != null) {
      value.append(
        el('strong', null, formatNumber(telemetry.epoch, 0)),
        el('span', null, `/ ${formatNumber(telemetry.total_epochs, 0)}`),
        el('small', null, 'epochs'),
      );
    } else if (telemetry?.updates != null) {
      value.append(el('strong', null, formatNumber(telemetry.updates, 0)), el('small', null, '更新步数'));
    } else {
      value.append(el('span', 'detail-progress-unavailable', '尚未报告进度'));
    }
    statistics.append(value);
    if (telemetry?.percent != null) {
      statistics.append(el('strong', 'detail-percent', `${formatNumber(telemetry.percent, 0)}%`));
    }
    section.append(statistics);
    if (telemetry?.percent != null) {
      const bar = progress(telemetry.percent, 'detail-progress-bar');
      bar.setAttribute('aria-label', telemetry.percent_kind === 'budget' ? '脚本训练预算进度' : '脚本报告进度');
      section.append(bar);
    }
    const metadata = el('div', 'detail-progress-meta');
    metadata.append(el('span', null, `阶段：${telemetry?.phase ?? '未报告'}`));
    const seconds = elapsed(job.attempt);
    metadata.append(el('span', null, seconds === null ? '尚未开始' : `已运行 ${formatDuration(seconds)}`));
    metadata.append(el('span', null, telemetry?.eta_seconds != null
      ? `脚本预计剩余 ≈ ${formatDuration(telemetry.eta_seconds)}`
      : '脚本预计剩余 —'));
    section.append(metadata);
    if (telemetry?.percent_kind === 'budget') {
      section.append(el('p', 'detail-progress-note', '百分比为脚本报告的训练预算进度，不代表验证或最终评估已经完成。'));
    }
    const start = el('p', 'detail-start-time', `开始时间　${formatDate(job.attempt?.started, config())}`);
    section.append(start);
    return section;
  }

  function gpuCard() {
    const gpu = job.attempt?.gpu;
    const section = el('section', 'detail-section gpu-metrics-card');
    const heading = el('div', 'detail-section-heading');
    heading.append(el('h3', null, gpu == null ? 'GPU 监控' : `GPU ${gpu} 监控`));
    const worker = getSnapshot()?.workers.find((item) => item.gpu === gpu);
    const metrics = worker?.metrics;
    section.append(heading);
    if (!metrics) {
      section.append(el('p', 'metrics-unavailable', gpu == null ? '尚未分配 GPU。' : '调度侧尚未提供 GPU 指标。'));
      return section;
    }
    const fields = el('div', 'gpu-metric-fields');
    const utilization = el('div', 'gpu-metric');
    utilization.append(icon('chip'), el('span', null, '利用率'));
    if (metrics.utilization_percent != null) {
      utilization.append(progress(metrics.utilization_percent, 'metric-progress'));
      utilization.append(el('strong', 'metric-utilization', `${formatNumber(metrics.utilization_percent, 0)}%`));
    } else utilization.append(el('span', 'muted', '未提供'));
    const memory = el('div', 'gpu-metric');
    memory.append(icon('database'), el('span', null, '显存'));
    if (metrics.memory_used_bytes != null && metrics.memory_total_bytes != null) {
      if (metrics.memory_total_bytes > 0) {
        memory.append(progress(metrics.memory_used_bytes / metrics.memory_total_bytes * 100, 'metric-progress'));
      }
      memory.append(el('strong', null, `${formatNumber(metrics.memory_used_bytes / 1024 ** 3, 1)} / ${formatNumber(metrics.memory_total_bytes / 1024 ** 3, 0)} GiB`));
    } else memory.append(el('span', 'muted', '未提供'));
    fields.append(utilization, memory);
    section.append(fields, el('p', 'metrics-updated', `调度侧指标更新：${formatDate(metrics.updated, config())}`));
    return section;
  }

  function renderLogLines(pre) {
    if (!lastLog || lastLog.jobId !== selectedId || lastLog.key !== logKey) {
      pre.textContent = job.logs.length ? '正在读取日志…' : '尚未生成日志';
      return;
    }
    const text = lastLog.text || '日志文件尚无输出';
    if (activeTab === 'logs') {
      pre.textContent = text;
      return;
    }
    const lines = text.replace(/\n$/, '').split('\n').slice(-6);
    pre.replaceChildren(...lines.map((line) => el('span', 'log-line', line || ' ')));
  }

  function logsCard() {
    const section = el('section', `detail-section detail-logs${activeTab === 'logs' ? ' is-expanded' : ''}`);
    const heading = el('div', 'detail-section-heading log-heading');
    heading.append(el('h3', null, activeTab === 'logs' ? '任务日志' : '最新日志'));
    const tools = el('div', 'log-actions');
    const followLabel = el('label', 'log-follow-label');
    const followInput = el('input');
    followInput.type = 'checkbox';
    followInput.id = 'follow-log';
    followInput.checked = follow;
    followInput.dataset.focusKey = 'follow-log';
    followInput.addEventListener('change', () => {
      follow = followInput.checked;
      const pre = container.querySelector('#log');
      if (follow) pre.scrollTop = pre.scrollHeight;
    });
    followLabel.append(followInput, el('span', 'switch-track'), el('span', null, '持续跟随'));
    const copy = iconButton('复制日志', 'copy');
    copy.dataset.focusKey = 'copy-log';
    copy.addEventListener('click', () => copyLog());
    if (!job.logs.length) disabledAction(copy, '尚未生成日志');
    let download;
    if (config().capabilities?.logDownload && logKey) {
      download = el('a', 'icon-button detail-icon-button');
      download.href = `/api/jobs/${job.id}/logs/${encodeURIComponent(logKey)}/download`;
      download.download = '';
      download.title = '下载日志';
      download.setAttribute('aria-label', '下载日志');
      download.append(icon('download'));
    } else download = disabledAction(iconButton('下载日志', 'download'), job.logs.length ? '当前服务尚未启用完整日志下载' : '尚未生成日志');
    tools.append(followLabel, copy, download);
    if (activeTab !== 'logs') {
      const all = button('查看全部', null, 'text-button');
      all.addEventListener('click', () => switchTab('logs'));
      tools.append(all);
    }
    heading.append(tools);
    section.append(heading);
    const source = el('select', 'log-source');
    source.id = 'log-source';
    source.dataset.focusKey = 'log-source';
    source.setAttribute('aria-label', '日志来源');
    source.disabled = !job.logs.length;
    for (const log of job.logs) {
      const option = el('option', null, log.label);
      option.value = log.key;
      option.selected = log.key === logKey;
      source.append(option);
    }
    if (!job.logs.length) source.append(el('option', null, '尚无日志来源'));
    source.addEventListener('change', () => {
      logKey = source.value;
      lastLog = null;
      render();
      loadLog().catch(report);
    });
    if (activeTab === 'logs' || job.logs.length > 1) section.append(source);
    const log = el('pre', 'detail-log-output');
    log.id = 'log';
    log.tabIndex = 0;
    log.setAttribute('aria-label', '日志内容');
    renderLogLines(log);
    section.append(log);
    if (activeTab === 'logs') {
      const updated = lastLog?.jobId === selectedId && lastLog?.key === logKey ? lastLog.updated : null;
      const caption = el('p', 'log-caption', `显示日志尾部最多 256 KiB · 更新 ${formatDate(updated, config())}。下载按钮获取完整日志。`);
      section.append(caption);
    }
    return section;
  }

  async function copyLog() {
    if (lastLog?.jobId !== selectedId || lastLog?.key !== logKey) return;
    const visible = activeTab === 'logs'
      ? lastLog.text
      : lastLog.text.replace(/\n$/, '').split('\n').slice(-6).join('\n');
    await copy(visible, '当前显示的日志片段已复制。');
  }

  function configurationPanel() {
    const section = el('section', 'detail-section configuration-panel');
    section.append(el('h3', null, '运行配置'));
    const facts = el('dl', 'detail-fact-list');
    facts.append(el('dt', null, '工作目录'), el('dd', null, job.cwd));
    const command = el('pre', 'configuration-command', job.argv.join(' '));
    facts.append(el('dt', null, '命令'), el('dd', null));
    facts.lastElementChild.append(command);
    if (job.tags?.length) {
      facts.append(el('dt', null, '实验标签'), el('dd', null, job.tags.join(' · ')));
    }
    if (job.telemetry?.source) {
      facts.append(el('dt', null, '进度来源'), el('dd', null, job.telemetry.source));
    }
    section.append(facts);
    if (job.telemetry) {
      const telemetry = el('dl', 'telemetry-facts');
      for (const [label, value] of [
        ['训练损失', job.telemetry.loss == null ? '未报告' : formatNumber(job.telemetry.loss, 5)],
        ['累计更新', formatNumber(job.telemetry.updates, 0)],
        ['处理样本', formatNumber(job.telemetry.samples, 0)],
        ['脚本吞吐', job.telemetry.images_per_second == null ? '未报告' : `${formatNumber(job.telemetry.images_per_second)} 图/秒`],
        ['预算结束', formatDate(job.telemetry.budget_end, config())],
      ]) {
        const item = el('div');
        item.append(el('dt', null, label), el('dd', null, value));
        telemetry.append(item);
      }
      section.append(telemetry);
    }
    return section;
  }

  function historyPanel() {
    const section = el('section', 'detail-section history-panel');
    section.append(el('h3', null, `运行记录 · ${job.attempts.length}`));
    if (!job.attempts.length) {
      section.append(el('p', 'detail-empty', '任务尚未开始，没有运行记录。'));
      return section;
    }
    const list = el('ol', 'attempt-history');
    for (const attempt of job.attempts) {
      const item = el('li');
      const heading = el('div', 'attempt-heading');
      heading.append(el('strong', null, `第 ${attempt.number} 次运行`), stateBadge(attempt.state));
      item.append(
        heading,
        el('p', null, `GPU ${attempt.gpu} · Job #${attempt.slurm_job_id}`),
        el('p', 'muted', `${formatDate(attempt.started, config())} → ${formatDate(attempt.finished, config())}`),
        el('p', 'muted', `${elapsed(attempt) === null ? '尚未开始' : `运行 ${formatDuration(elapsed(attempt))}`} · 退出码 ${attempt.exit_code ?? '—'}`),
      );
      if (attempt.message) item.append(el('p', 'attempt-message', attempt.message));
      list.append(item);
    }
    section.append(list);
    return section;
  }

  function renderFooter() {
    const footer = el('footer', 'detail-footer');
    const viewActions = el('div', 'detail-view-actions');
    const copyConfig = button('复制配置', 'copy', 'button');
    copyConfig.dataset.focusKey = 'copy-config';
    copyConfig.addEventListener('click', () => copy(JSON.stringify(visibleConfiguration(), null, 2), '当前任务配置已复制。'));
    const artifacts = button('查看产物', 'folder', 'button');
    artifacts.dataset.focusKey = 'artifacts';
    if (config().capabilities?.artifacts) artifacts.addEventListener('click', () => showArtifacts());
    else disabledAction(artifacts, '当前服务尚未启用产物查看');
    viewActions.append(copyConfig, artifacts);
    const cancel = button('取消任务', 'trash', 'button danger');
    cancel.dataset.focusKey = 'cancel';
    if (pendingCancellations.has(job.id)) disabledAction(cancel, '取消请求已提交，正在等待队列更新');
    else if (!cancellableStates.has(job.state)) disabledAction(cancel, '任务已经结束');
    else if (!config().capabilities?.cancelJobs) disabledAction(cancel, '当前服务以只读模式运行');
    else cancel.addEventListener('click', showCancellation);
    footer.append(viewActions, cancel);
    return footer;
  }

  function render() {
    if (!job || activeDialog?.open) return;
    const focused = container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    const oldLog = container.querySelector('#log');
    const previousScroll = oldLog?.scrollTop ?? 0;
    const panel = el('div', 'detail-tab-panel');
    panel.id = 'detail-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `detail-tab-${activeTab}`);
    if (activeTab === 'overview') panel.append(progressCard(), gpuCard(), logsCard());
    if (activeTab === 'logs') panel.append(logsCard());
    if (activeTab === 'config') panel.append(configurationPanel());
    if (activeTab === 'history') panel.append(historyPanel());
    const status = el('p', 'detail-announcement', announcement);
    status.setAttribute('role', 'status');
    container.replaceChildren(renderHeader(), renderTabs(), panel, renderFooter(), status);
    const log = container.querySelector('#log');
    if (log) log.scrollTop = follow ? log.scrollHeight : previousScroll;
    if (focused) container.querySelector(`[data-focus-key="${focused}"]`)?.focus({ preventScroll: true });
  }

  async function loadLog() {
    if (!job || !logKey || !['overview', 'logs'].includes(activeTab)) return;
    logController?.abort();
    logController = new AbortController();
    const sequence = ++logSequence;
    const id = selectedId;
    const key = logKey;
    const result = await api(`/api/jobs/${id}/logs/${encodeURIComponent(key)}`, { signal: logController.signal });
    if (sequence !== logSequence || id !== selectedId || key !== logKey) return;
    lastLog = { ...result, jobId: id, key };
    const log = container.querySelector('#log');
    if (log) {
      const previousScroll = log.scrollTop;
      renderLogLines(log);
      log.scrollTop = follow ? log.scrollHeight : previousScroll;
    }
    const caption = container.querySelector('.log-caption');
    if (caption) caption.textContent = `显示日志尾部最多 256 KiB · 更新 ${formatDate(result.updated, config())}。下载按钮获取完整日志。`;
  }

  async function refresh() {
    if (selectedId == null) return;
    detailController?.abort();
    detailController = new AbortController();
    const id = selectedId;
    const sequence = ++detailSequence;
    container.setAttribute('aria-busy', 'true');
    try {
      const result = await api(`/api/jobs/${id}`, { signal: detailController.signal });
      if (sequence !== detailSequence || selectedId !== id) return;
      job = result;
      if (!cancellableStates.has(job.state)) pendingCancellations.delete(id);
      if (!job.logs.some((source) => source.key === logKey)) {
        logKey = job.logs.find((source) => source.key.startsWith('project-'))?.key ?? job.logs[0]?.key ?? null;
        lastLog = null;
      }
      render();
      await loadLog();
    } catch (error) {
      report(error);
    } finally {
      if (sequence === detailSequence) container.setAttribute('aria-busy', 'false');
    }
  }

  function clear() {
    selectedId = null;
    job = null;
    logKey = null;
    lastLog = null;
    announcement = '';
    detailController?.abort();
    logController?.abort();
    activeDialog?.close();
    container.setAttribute('aria-busy', 'false');
    container.replaceChildren(el('div', 'detail-empty', '选择一个任务，查看进度与日志。'));
  }

  async function select(id) {
    if (selectedId === id) return refresh();
    clear();
    selectedId = id;
    activeTab = 'overview';
    container.replaceChildren(el('div', 'detail-empty', '正在读取任务详情…'));
    await refresh();
  }

  return { select, refresh, clear };
}
