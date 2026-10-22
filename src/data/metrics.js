import { progressFile } from './files.js';

/** Consume a scheduler/exporter snapshot; the panel never probes GPU hardware. */
export async function readGpuMetrics(path) {
  if (!path) return [];
  const snapshot = await progressFile(path);
  if (!Array.isArray(snapshot?.record.gpus)) return [];
  return snapshot.record.gpus.map((record) => {
    const normalized = {
      gpu: record.gpu,
      utilization_percent: record.utilization_percent ?? record.utilization,
      memory_used_bytes: record.memory_used_bytes,
      memory_total_bytes: record.memory_total_bytes,
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
