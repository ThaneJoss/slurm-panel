import { progressFile } from './files.js';

/** Consume a scheduler/exporter snapshot; the panel never probes GPU hardware. */
export async function readGpuMetrics(path) {
  if (!path) return [];
  const snapshot = await progressFile(path);
  if (!Array.isArray(snapshot?.record.gpus)) return [];
  return snapshot.record.gpus.map((record) => {
    const normalized = {
      gpu: record.gpu,
      uuid: record.uuid,
      utilization_percent: record.utilization_percent ?? record.utilization,
      utilization_5m_percent: record.utilization_5m_percent,
      utilization_window_seconds: record.utilization_window_seconds,
      memory_used_bytes: record.memory_used_bytes,
      memory_total_bytes: record.memory_total_bytes,
      processes: Array.isArray(record.processes) ? record.processes.map((process) => ({
        pid: process.pid, user: process.user, name: process.name,
        type: process.type, memory_used_bytes: process.memory_used_bytes,
      })) : null,
      process_count: record.process_count ?? (Array.isArray(record.processes) ? record.processes.length : null),
      sample_interval_seconds: snapshot.record.sample_interval_seconds ?? null,
      updated: record.updated ?? snapshot.updated,
    };
    // gpuq status --json publishes MiB; normalized exporter snapshots use bytes.
    if (Number.isFinite(record.total_mib) && Number.isFinite(record.free_mib)) {
      normalized.memory_used_bytes ??= (record.total_mib - record.free_mib) * 1024 ** 2;
      normalized.memory_total_bytes ??= record.total_mib * 1024 ** 2;
    }
    return normalized;
  });
}
