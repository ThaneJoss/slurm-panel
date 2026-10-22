import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  averageUtilization, GpuHistory, parseGpuInventory, parseGpuProcesses, parseUsers, processOwners,
} from '../src/data/gpu-monitor.js';
import { readGpuMetrics } from '../src/data/metrics.js';
import { enrichWorkers } from '../src/data/query.js';

test('NVIDIA data covers all compute and graphics processes without publishing executable paths', async () => {
  const inventory = parseGpuInventory('0, GPU-fixture, 65, 12288, 24576\n1, GPU-other, N/A, 0, 24576\n');
  assert.equal(inventory[0].memory_used_bytes, 12 * 1024 ** 3);
  assert.equal(inventory[0].memory_total_bytes, 24 * 1024 ** 3);
  assert.equal(inventory[1].utilization_percent, null);
  assert.equal(inventory[1].memory_used_bytes, 0);

  const processes = parseGpuProcesses(`<?xml version="1.0"?>
    <nvidia_smi_log><gpu id="fixture">
      <uuid>GPU-fixture</uuid>
      <processes>
        <process_info><pid>111</pid><type>C</type><process_name>/private/alice/bin/python</process_name><used_memory>12000 MiB</used_memory></process_info>
        <process_info><pid>222</pid><type>G</type><process_name>/private/bob/render&amp;view</process_name><used_memory>288 MiB</used_memory></process_info>
      </processes>
    </gpu><gpu id="other"><uuid>GPU-other</uuid><processes></processes></gpu>
    <gpu id="unavailable"><uuid>GPU-unknown</uuid><processes>N/A</processes></gpu></nvidia_smi_log>`);
  const users = parseUsers('alice:x:1001:1001::/home/alice:/bin/bash\nbob:x:2002:2002::/home/bob:/bin/bash\n');
  const owned = await processOwners(processes.get('GPU-fixture'), users, async (pid) => pid === 111 ? 1001 : 2002);
  assert.deepEqual(owned.map(({ pid, user, type, name }) => ({ pid, user, type, name })), [
    { pid: 111, user: 'alice', type: 'C', name: 'python' },
    { pid: 222, user: 'bob', type: 'G', name: 'render&view' },
  ]);
  assert.equal(owned[0].memory_used_bytes, 12000 * 1024 ** 2);
  assert.equal(JSON.stringify(owned).includes('/private/'), false);
  assert.deepEqual(processes.get('GPU-other'), []);
  assert.equal(processes.get('GPU-unknown'), null);
  assert.equal((await processOwners([owned[0]], users, async () => null))[0].user, null);
});

test('five-minute utilization is duration weighted, clipped to the window and preserves real zero', () => {
  const samples = [
    { timestamp: 0, utilization_percent: 20 },
    { timestamp: 100, utilization_percent: 100 },
    { timestamp: 300, utilization_percent: 0 },
  ];
  const average = averageUtilization(samples, 400, 100);
  assert.equal(average.utilization_window_seconds, 300);
  assert.equal(average.utilization_5m_percent, 20000 / 300);
  const zero = averageUtilization([{ timestamp: 300, utilization_percent: 0 }], 310, 5);
  assert.deepEqual(zero, { utilization_5m_percent: 0, utilization_window_seconds: 10 });
  assert.deepEqual(averageUtilization([{ timestamp: 310, utilization_percent: 65 }], 310, 5), {
    utilization_5m_percent: null, utilization_window_seconds: 0,
  });
});

test('collector failure stays unknown and restarting resumes only actually observed coverage', () => {
  const gpu = { gpu: 0, uuid: 'GPU-fixture', utilization_percent: 80, processes: [], process_count: 0 };
  const history = new GpuHistory();
  history.snapshot([gpu], 100);
  history.snapshot([gpu], 105);
  const unavailable = history.snapshot(null, 110);
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.gpus, []);

  const resumed = new GpuHistory(JSON.parse(JSON.stringify(unavailable.history)));
  const after = resumed.snapshot([{ ...gpu, utilization_percent: 20 }], 130);
  assert.equal(after.gpus[0].utilization_5m_percent, 80);
  assert.equal(after.gpus[0].utilization_window_seconds, 10);
  const later = resumed.snapshot([{ ...gpu, utilization_percent: 20 }], 135);
  assert.equal(later.gpus[0].utilization_5m_percent, 60);
  assert.equal(later.gpus[0].utilization_window_seconds, 15);

  const longRestart = new GpuHistory(JSON.parse(JSON.stringify(later.history)));
  const fresh = longRestart.snapshot([gpu], 1000);
  assert.equal(fresh.gpus[0].utilization_5m_percent, null);
  assert.equal(fresh.gpus[0].utilization_window_seconds, 0);
});

test('metrics reader keeps host process and mean fields but excludes collector history and private fields', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'slurm-gpu-metrics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'gpus.json');
  const gpu = {
    gpu: 4, uuid: 'GPU-fixture', utilization_percent: 90,
    utilization_5m_percent: 65, utilization_window_seconds: 300,
    memory_used_bytes: 12 * 1024 ** 3, memory_total_bytes: 24 * 1024 ** 3,
    updated: 1000, process_count: 1,
    processes: [{ pid: 111, user: 'alice', name: 'python', type: 'C', memory_used_bytes: 12 * 1024 ** 3, cmdline: 'private-token' }],
    private_path: '/private/collector',
  };
  await writeFile(path, JSON.stringify({ sample_interval_seconds: 5, gpus: [gpu], history: [{ private_sample: true }] }));
  const [read] = await readGpuMetrics(path);
  assert.equal(read.gpu, 4);
  assert.equal(read.utilization_5m_percent, 65);
  assert.equal(read.utilization_window_seconds, 300);
  assert.equal(read.process_count, 1);
  assert.equal(read.processes[0].user, 'alice');
  assert.equal(read.sample_interval_seconds, 5);
  const serialized = JSON.stringify(read);
  assert.equal(serialized.includes('private-token'), false);
  assert.equal(serialized.includes('/private/collector'), false);
  assert.equal(serialized.includes('private_sample'), false);
});

test('count-only exporter snapshots preserve occupancy while invalid counts remain unknown', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'slurm-gpu-counts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'gpus.json');
  const records = [
    { process_count: 0 },
    { process_count: 3, utilization_percent: 0 },
    { process_count: 2 },
    { process_count: '2' },
    { process_count: 99, processes: [] },
    { process_count: 0, processes: [{ pid: 111, user: 'alice', name: 'python', type: 'C' }] },
    ...[undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, '', 'unknown']
      .map((process_count) => ({ process_count, memory_total_bytes: 24 * 1024 ** 3 })),
    { process_count: -1 },
  ].map((record, gpu) => ({ gpu, updated: 1000, ...record }));
  await writeFile(path, JSON.stringify({ gpus: records }));
  const workers = enrichWorkers([], [], await readGpuMetrics(path), 1005);

  assert.deepEqual(workers.slice(0, 6).map((worker) => [worker.state, worker.metrics.process_count]), [
    ['idle', 0], ['running', 3], ['running', 2], ['running', 2], ['idle', 0], ['running', 1],
  ]);
  assert.equal(workers[0].metrics.utilization_percent, null);
  assert.equal(workers[0].metrics.processes, null);
  assert.equal(workers[2].metrics.utilization_percent, null);
  assert.equal(workers[2].metrics.processes, null);
  for (const worker of workers.slice(6, -1)) {
    assert.equal(worker.state, 'unknown');
    assert.equal(worker.metrics.process_count, null);
  }
  assert.equal(workers.at(-1).state, 'unknown');
  assert.equal(workers.at(-1).metrics, null);
});
