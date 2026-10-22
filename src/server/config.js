import { isAbsolute } from 'node:path';

function positiveInteger(value, name, defaultValue) {
  if (value === undefined || value === '') return defaultValue;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return result;
}

export function readConfig(env = process.env, args = process.argv.slice(2)) {
  for (const arg of args) {
    if (arg !== '--demo') throw new Error(`Unknown argument: ${arg}`);
  }
  const mode = args.includes('--demo') ? 'demo' : (env.PANEL_MODE || 'demo');
  if (!['demo', 'gpuq'].includes(mode)) {
    throw new Error('PANEL_MODE must be demo or gpuq');
  }
  const databasePath = env.GPUQ_DATABASE || null;
  if (mode === 'gpuq' && (!databasePath || !isAbsolute(databasePath))) {
    throw new Error('GPUQ_DATABASE must be an absolute path in gpuq mode');
  }
  const metricsFile = env.GPU_METRICS_FILE || null;
  if (metricsFile && !isAbsolute(metricsFile)) throw new Error('GPU_METRICS_FILE must be an absolute path');
  const port = positiveInteger(env.PORT, 'PORT', 5013);
  if (port > 65535) throw new Error('PORT must be at most 65535');

  let slurmWebUrl = null;
  if (env.SLURM_WEB_URL) {
    const url = new URL(env.SLURM_WEB_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('SLURM_WEB_URL must be an HTTP(S) URL without credentials');
    }
    slurmWebUrl = url.href;
  }
  const timeZone = env.TZ || null;
  if (timeZone) new Intl.DateTimeFormat('en', { timeZone });

  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port,
    databasePath,
    metricsFile,
    mode,
    clusterName: env.PANEL_CLUSTER_NAME || 'SLURM',
    title: env.PANEL_TITLE || '实验进度',
    slurmWebUrl,
    timeZone,
    refreshIntervalMs: positiveInteger(env.REFRESH_INTERVAL_MS, 'REFRESH_INTERVAL_MS', 5000),
    capabilities: Object.freeze({ cancelJobs: false, cancellationRequiresToken: false, artifacts: false, logDownload: false }),
  });
}

export function publicConfig(config) {
  const { title, clusterName, slurmWebUrl, refreshIntervalMs, timeZone, mode, capabilities } = config;
  return { title, clusterName, slurmWebUrl, refreshIntervalMs, timeZone, mode, capabilities };
}
