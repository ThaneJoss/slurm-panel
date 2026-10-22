import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MIB = 1024 ** 2;
export const GPU_WINDOW_SECONDS = 300;

function numeric(value) {
  if (value == null || value.trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function parseGpuInventory(csv) {
  return csv.trim().split('\n').filter(Boolean).map((line) => {
    const [index, uuid, utilization, used, total] = line.split(',').map((value) => value.trim());
    const gpu = numeric(index);
    if (!Number.isInteger(gpu) || gpu < 0 || !uuid) throw new Error('Invalid GPU inventory');
    const usedMib = numeric(used);
    const totalMib = numeric(total);
    return {
      gpu, uuid,
      utilization_percent: numeric(utilization),
      memory_used_bytes: usedMib === null ? null : usedMib * MIB,
      memory_total_bytes: totalMib === null ? null : totalMib * MIB,
    };
  });
}

function xmlText(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
  });
}

function tag(xml, name) {
  return xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? null;
}

/** NVIDIA's XML processes section includes compute, graphics, MPS and other contexts. */
export function parseGpuProcesses(xml) {
  const result = new Map();
  for (const [, device] of xml.matchAll(/<gpu\b[^>]*>([\s\S]*?)<\/gpu>/g)) {
    const uuid = tag(device, 'uuid');
    const section = tag(device, 'processes');
    if (!uuid) continue;
    if (section === null || section === 'N/A') {
      result.set(uuid, null);
      continue;
    }
    const processes = [];
    for (const [, entry] of section.matchAll(/<process_info>([\s\S]*?)<\/process_info>/g)) {
      const pid = numeric(tag(entry, 'pid'));
      if (!Number.isInteger(pid) || pid < 1) continue;
      const memory = tag(entry, 'used_memory')?.match(/^([\d.]+) MiB$/);
      processes.push({
        pid,
        name: basename(xmlText(tag(entry, 'process_name') ?? 'unknown')),
        type: tag(entry, 'type'),
        memory_used_bytes: memory ? Number(memory[1]) * MIB : null,
      });
    }
    result.set(uuid, processes);
  }
  return result;
}

export function parseUsers(passwd) {
  return new Map(passwd.split('\n').filter(Boolean).map((line) => {
    const [name, , uid] = line.split(':');
    return [Number(uid), name];
  }));
}

async function processUid(pid) {
  try {
    return (await stat(`/proc/${pid}`)).uid;
  } catch (error) {
    // A process can exit between NVIDIA's snapshot and reading its owner.
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw error;
  }
}

export async function processOwners(processes, users, getUid = processUid) {
  if (processes === null) return null;
  return Promise.all(processes.map(async (record) => {
    const uid = await getUid(record.pid);
    return { ...record, user: uid === null ? null : (users.get(uid) ?? String(uid)) };
  }));
}

/** Run only in the dedicated monitor service, never in HTTP requests or task submission. */
export async function sampleNvidiaGpus(command = 'nvidia-smi') {
  const options = { timeout: 10000, maxBuffer: 8 * 1024 ** 2, encoding: 'utf8' };
  const [inventory, details, passwd] = await Promise.all([
    execute(command, [
      '--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], options),
    execute(command, ['-q', '-x'], options),
    readFile('/etc/passwd', 'utf8'),
  ]);
  const byUuid = parseGpuProcesses(details.stdout);
  const users = parseUsers(passwd);
  return Promise.all(parseGpuInventory(inventory.stdout).map(async (gpu) => {
    const processes = await processOwners(byUuid.get(gpu.uuid) ?? null, users);
    return { ...gpu, processes, process_count: processes?.length ?? null };
  }));
}

function recentSamples(samples, now) {
  const cutoff = now - GPU_WINDOW_SECONDS;
  const first = samples.findIndex((sample) => sample.timestamp >= cutoff);
  if (first === -1) return samples.slice(-1);
  return samples.slice(Math.max(0, first - 1));
}

/** Integrate sample values over their actual duration, omitting unavailable intervals. */
export function averageUtilization(samples, now, intervalSeconds) {
  const cutoff = now - GPU_WINDOW_SECONDS;
  let integral = 0;
  let covered = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!Number.isFinite(sample.utilization_percent)) continue;
    const start = Math.max(cutoff, sample.timestamp);
    // A stopped collector must not turn its last value into minutes of invented data.
    const end = Math.min(now, samples[index + 1]?.timestamp ?? now, sample.timestamp + intervalSeconds * 2);
    const duration = Math.max(0, end - start);
    integral += sample.utilization_percent * duration;
    covered += duration;
  }
  return {
    utilization_5m_percent: covered > 0 ? integral / covered : null,
    utilization_window_seconds: covered,
  };
}

export class GpuHistory {
  constructor(history = [], intervalSeconds = 5) {
    this.history = new Map(history.map((entry) => [entry.uuid, entry]));
    this.intervalSeconds = intervalSeconds;
  }

  snapshot(gpus, now) {
    const available = gpus !== null;
    const current = new Map((gpus ?? []).map((gpu) => [gpu.uuid, gpu]));
    for (const gpu of gpus ?? []) {
      if (!this.history.has(gpu.uuid)) this.history.set(gpu.uuid, { uuid: gpu.uuid, samples: [] });
    }
    for (const [uuid, entry] of this.history) {
      const value = current.get(uuid)?.utilization_percent ?? null;
      const previous = entry.samples.at(-1);
      if (previous?.timestamp === now) previous.utilization_percent = value;
      else entry.samples.push({ timestamp: now, utilization_percent: value });
      entry.samples = recentSamples(entry.samples, now);
      if (!current.has(uuid) && entry.samples.every((sample) => sample.utilization_percent === null)) {
        this.history.delete(uuid);
      }
    }
    return {
      version: 1,
      available,
      updated: now,
      sample_interval_seconds: this.intervalSeconds,
      window_seconds: GPU_WINDOW_SECONDS,
      gpus: (gpus ?? []).map((gpu) => ({
        ...gpu, updated: now,
        ...averageUtilization(this.history.get(gpu.uuid).samples, now, this.intervalSeconds),
      })),
      history: [...this.history.values()],
    };
  }
}
