import { open, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const OUTPUT_VARIABLES = ['V6B_OUTPUT', 'OUTPUT_DIR', 'RUN_DIR', 'TRAIN_OUTPUT_DIR'];
const OUTPUT_OPTIONS = ['--output', '--output-dir', '--run-dir'];
const PROGRESS_LIMIT = 1024 * 1024;

function isMissing(error) {
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

export async function fileInfo(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

// Open first and stat the descriptor so rotation/truncation cannot mix two files.
async function readFileSection(path, limit, fromEnd) {
  let file;
  try {
    file = await open(path, 'r');
    const info = await file.stat();
    if (!info.isFile() || (!fromEnd && info.size > limit)) return null;
    const length = Math.min(info.size, limit);
    const buffer = Buffer.alloc(length);
    const position = fromEnd ? Math.max(0, info.size - length) : 0;
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { text: buffer.toString('utf8', 0, offset), updated: info.mtimeMs / 1000 };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  } finally {
    await file?.close();
  }
}

export async function tail(path, limit = 256 * 1024) {
  const result = await readFileSection(path, limit, true);
  if (!result) return { text: '', updated: null };
  return {
    text: stripVTControlCharacters(result.text).replaceAll('\r', '\n'),
    updated: result.updated,
  };
}

export async function progressFile(path) {
  const result = await readFileSection(path, PROGRESS_LIMIT, false);
  if (!result) return null;
  try {
    const record = JSON.parse(result.text);
    if (record === null || Array.isArray(record) || typeof record !== 'object') return null;
    return { record, updated: result.updated };
  } catch (error) {
    // Training scripts may be in the middle of replacing a progress document.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function outputCandidates(job, environment) {
  const candidates = [];
  for (const key of OUTPUT_VARIABLES) {
    if (environment[key]) candidates.push(environment[key]);
  }
  for (let index = 0; index < job.argv.length; index += 1) {
    const arg = job.argv[index];
    if (OUTPUT_OPTIONS.includes(arg) && index + 1 < job.argv.length) {
      candidates.push(job.argv[index + 1]);
    }
    for (const option of OUTPUT_OPTIONS) {
      if (arg.startsWith(`${option}=`)) candidates.push(arg.slice(option.length + 1));
    }
  }
  return [...new Set(candidates.map((path) => resolve(job.cwd, path)))];
}

export function directoryCandidates(job, environment) {
  const candidates = outputCandidates(job, environment);
  for (const arg of job.argv) {
    if (isAbsolute(arg) && arg.endsWith('.sh')) candidates.push(dirname(arg));
  }
  candidates.push(job.cwd);
  return [...new Set(candidates.map((path) => resolve(job.cwd, path)))];
}

export async function outputDirectories(job, environment) {
  const unique = directoryCandidates(job, environment);
  const metadata = await Promise.all(unique.map(fileInfo));
  return unique.filter((_, index) => metadata[index]?.isDirectory());
}
