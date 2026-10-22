import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileInfo, outputCandidates } from './files.js';

const ARTIFACT_EXTENSIONS = new Set([
  '.pt', '.pth', '.ckpt', '.safetensors', '.json', '.jsonl', '.csv', '.tsv',
  '.png', '.jpg', '.jpeg', '.webp', '.pdf',
]);
const LIMIT = 200;

function isArtifact(name) {
  return !name.startsWith('.') && ARTIFACT_EXTENSIONS.has(extname(name).toLowerCase());
}

/** List metadata in explicitly submitted output locations, without reading contents. */
export async function artifactMetadata(job, environment) {
  const directories = [];
  const files = [];
  let truncated = false;
  const seen = new Set();

  async function addFile(path, info) {
    if (!info?.isFile() || !isArtifact(basename(path)) || seen.has(path)) return;
    if (files.length === LIMIT) {
      truncated = true;
      return;
    }
    seen.add(path);
    files.push({ name: basename(path), path, size: info.size, modified: info.mtimeMs / 1000 });
  }

  for (const candidate of outputCandidates(job, environment)) {
    const info = await fileInfo(candidate);
    if (info?.isFile()) {
      await addFile(candidate, info);
      continue;
    }
    if (!info?.isDirectory()) continue;
    directories.push(candidate);
    let entries;
    try {
      entries = await readdir(candidate, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !isArtifact(entry.name)) continue;
      const path = join(candidate, entry.name);
      await addFile(path, await fileInfo(path));
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { directories, files, truncated };
}
