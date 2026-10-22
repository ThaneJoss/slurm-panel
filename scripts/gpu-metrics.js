#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { GpuHistory, sampleNvidiaGpus } from '../src/data/gpu-monitor.js';

const path = process.env.GPU_METRICS_FILE;
if (!path || !isAbsolute(path)) throw new Error('GPU_METRICS_FILE must be an absolute path');
const intervalMs = Number(process.env.GPU_METRICS_INTERVAL_MS || 5000);
if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
  throw new Error('GPU_METRICS_INTERVAL_MS must be a positive integer');
}
const command = process.env.NVIDIA_SMI_COMMAND || 'nvidia-smi';
await mkdir(dirname(path), { recursive: true });
let previous = [];
try {
  previous = JSON.parse(await readFile(path, 'utf8')).history ?? [];
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const history = new GpuHistory(previous, intervalMs / 1000);
const temporary = `${path}.${process.pid}.tmp`;
let timer;
let stopped = false;

async function sample() {
  const started = Date.now();
  let gpus;
  try {
    gpus = await sampleNvidiaGpus(command);
  } catch (error) {
    console.error(`GPU monitor unavailable: ${error.code ?? error.name}`);
    gpus = null;
  }
  const snapshot = history.snapshot(gpus, Date.now() / 1000);
  await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(temporary, path);
  if (!stopped) timer = setTimeout(() => sample().catch(fatal), Math.max(0, intervalMs - (Date.now() - started)));
}

function fatal(error) {
  console.error(`GPU monitor could not write snapshot: ${error.code ?? error.name}`);
  process.exitCode = 1;
}

function shutdown() {
  stopped = true;
  clearTimeout(timer);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await sample();
