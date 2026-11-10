import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// Linux UAPI O_PATH (Node does not expose it): hold a directory without
// requiring read/list permission in addition to normal traversal permission.
const LINUX_O_PATH = 0x200000;
const UNAVAILABLE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENXIO', 'EACCES', 'EPERM']);

/**
 * Open a queue-advertised log without following task-controlled symlinks.
 * Linux /proc/self/fd anchors every lookup to an already opened directory:
 * checking realpath/lstat and then opening the original name would race renames.
 * Callers own the returned descriptor. Normal rename/create rotation is allowed.
 */
export async function openLogFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null;
  const parts = path.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.includes('..')) return null;
  if (process.platform !== 'linux'
    || !Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error('Secure queue log reads require Linux with /proc/self/fd available.');
  }
  const directoryFlags = LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let directory;
  let file;
  try {
    directory = await open('/', directoryFlags);
    for (const part of parts.slice(0, -1)) {
      const previous = directory;
      directory = await open(`/proc/self/fd/${previous.fd}/${part}`, directoryFlags);
      await previous.close();
    }
    file = await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) return null;
    const result = file;
    file = null;
    return result;
  } catch (error) {
    if (UNAVAILABLE.has(error.code)) return null;
    throw error;
  } finally {
    try {
      await file?.close();
    } finally {
      await directory?.close();
    }
  }
}
