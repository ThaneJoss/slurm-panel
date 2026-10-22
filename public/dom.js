export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

const drawings = {
  play: [['path', { d: 'M9 5v14l11-7Z', fill: 'currentColor', stroke: 'none' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 6v6l4 2' }]],
  check: [['path', { d: 'm5 12 4 4L19 6' }]],
  close: [['path', { d: 'm6 6 12 12M18 6 6 18' }]],
  slash: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'm5.5 18.5 13-13' }]],
  refresh: [['path', { d: 'M20 11a8 8 0 1 0-2.5 7.3M20 4v7h-7' }]],
  chip: [['rect', { x: 5, y: 5, width: 14, height: 14, rx: 2 }], ['rect', { x: 9, y: 9, width: 6, height: 6 }], ['path', { d: 'M9 2v3m6-3v3m4 4h3m-3 6h3M9 19v3m6-3v3M2 9h3m-3 6h3' }]],
  database: [['ellipse', { cx: 12, cy: 5, rx: 8, ry: 3 }], ['path', { d: 'M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0' }]],
  search: [['circle', { cx: 10.5, cy: 10.5, r: 6.5 }], ['path', { d: 'm16 16 5 5' }]],
  alert: [['circle', { cx: 12, cy: 12, r: 10, fill: 'currentColor', stroke: 'none' }], ['path', { d: 'M12 6v7m0 4v.01', stroke: 'white' }]],
  arrowLeft: [['path', { d: 'm15 5-7 7 7 7' }]],
  arrowRight: [['path', { d: 'm9 5 7 7-7 7' }]],
  chevronUp: [['path', { d: 'm5 15 7-7 7 7' }]],
  chevronDown: [['path', { d: 'm5 9 7 7 7-7' }]],
  copy: [['rect', { x: 8, y: 7, width: 12, height: 14, rx: 2 }], ['path', { d: 'M15 7V3H4v13h4' }]],
  download: [['path', { d: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5' }]],
  folder: [['path', { d: 'M3 6V4h7l3 3h8v13H3Z' }]],
  trash: [['path', { d: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7' }]],
  more: [['circle', { cx: 5, cy: 12, r: 1, fill: 'currentColor' }], ['circle', { cx: 12, cy: 12, r: 1, fill: 'currentColor' }], ['circle', { cx: 19, cy: 12, r: 1, fill: 'currentColor' }]],
};

export function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true })) {
    svg.setAttribute(key, String(value));
  }
  for (const [tag, attributes] of drawings[name] ?? []) {
    const part = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, String(value));
    svg.append(part);
  }
  return svg;
}

export function formatNumber(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const minutes = Math.floor(Math.max(0, Number(seconds)) / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)}时${String(minutes % 60).padStart(2, '0')}分`;
}

export function formatDate(value, config, timeOnly = false) {
  if (value == null || value === 0) return '—';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return '—';
  const options = { hour12: false };
  if (config?.timeZone) options.timeZone = config.timeZone;
  return timeOnly ? date.toLocaleTimeString('zh-CN', options) : date.toLocaleString('zh-CN', options);
}

export const activeStates = new Set(['assigned', 'launching', 'starting', 'running']);
export const statusNames = {
  assigned: '已分配', launching: '启动中', starting: '初始化', running: '运行中',
  queued: '排队中', waiting_resources: '等待资源', succeeded: '已完成', failed: '失败',
  cancelled: '已取消', oom: '显存不足',
};

export function stateBadge(state, stale = false) {
  const node = el('span', 'badge', stale ? '需检查' : statusNames[state] ?? state);
  if (stale) node.classList.add('warning');
  else if (activeStates.has(state)) node.classList.add('active');
  else node.classList.add(state === 'waiting_resources' ? 'queued' : state);
  return node;
}

export function progress(value, className = '') {
  const node = el('progress', `progress ${className}`.trim());
  node.max = 100;
  node.value = Math.min(100, Math.max(0, Number(value) || 0));
  node.setAttribute('aria-label', '脚本报告的进度');
  return node;
}

export function progressTrack(value, label, className = '') {
  if (value != null) {
    const node = progress(value, className);
    node.setAttribute('aria-label', label);
    return node;
  }
  const node = el('span', `progress progress-unavailable ${className}`.trim());
  node.setAttribute('role', 'progressbar');
  node.setAttribute('aria-label', label);
  node.setAttribute('aria-valuemin', '0');
  node.setAttribute('aria-valuemax', '100');
  node.setAttribute('aria-valuetext', '尚未报告');
  return node;
}

export function gpuMemory(metrics) {
  if (metrics?.memory_used_bytes == null || metrics.memory_total_bytes == null) return '—';
  return `${formatNumber(metrics.memory_used_bytes / 1024 ** 3, 1)}G/${formatNumber(metrics.memory_total_bytes / 1024 ** 3, 1)}G`;
}

export function utilizationWindow(metrics) {
  const seconds = metrics?.utilization_window_seconds;
  if (seconds == null) return '';
  return seconds >= 300 ? '5 分钟平均' : seconds >= 60 ? `近 ${formatNumber(seconds / 60, 1)} 分钟平均` : '正在采集 5 分钟均值';
}

export function gpuProcesses(metrics, className = '') {
  const processes = metrics?.processes;
  const details = el('details', `gpu-processes ${className}`.trim());
  const count = metrics?.process_count;
  details.append(el('summary', null, count == null ? '进程信息未知' : `${count} 个进程 · 所有用户`));
  if (!Array.isArray(processes)) {
    details.append(el('p', 'muted', '尚未提供进程信息'));
  } else if (processes.length === 0) {
    details.append(el('p', 'muted', '暂无 GPU 进程'));
  } else {
    const list = el('ul', 'gpu-process-list');
    for (const process of processes) {
      const item = el('li', 'gpu-process');
      const name = el('span', 'gpu-process-name', process.name || '未知进程');
      name.title = process.name || '未知进程';
      item.append(
        el('strong', 'gpu-process-user', process.user ?? '未知用户'),
        name,
        el('small', 'gpu-process-meta', `PID ${process.pid ?? '—'} · ${process.memory_used_bytes == null ? '显存未知' : `${formatNumber(process.memory_used_bytes / 1024 ** 3, 1)}G`}`),
      );
      list.append(item);
    }
    details.append(list);
  }
  return details;
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Private-network HTTP deployments do not expose the Clipboard API.
  const input = el('textarea', 'clipboard-buffer');
  input.value = text;
  input.setAttribute('aria-hidden', 'true');
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('浏览器未允许复制，请手动选择文本。');
}
