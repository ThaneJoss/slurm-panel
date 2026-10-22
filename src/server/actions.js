import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const CANCELLABLE = new Set(['queued', 'waiting_resources', 'assigned', 'launching', 'starting', 'running']);

function json(request, response, status, body) {
  const text = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': text.length });
  response.end(request.method === 'HEAD' ? undefined : text);
}

function methodNotAllowed(request, response, allow) {
  response.setHeader('Allow', allow);
  json(request, response, 405, { error: 'Method not allowed.' });
}

function authorized(request, token) {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sameOrigin(request, configuredOrigin) {
  if (request.headers.origin === undefined) return true;
  const protocol = request.socket.encrypted ? 'https' : 'http';
  const origin = configuredOrigin ?? `${protocol}://${request.headers.host}`;
  return request.headers.origin === origin;
}

async function bodyIsObject(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 4096) chunks.push(chunk);
  }
  if (size > 4096) return { status: 413, error: 'Request body is too large.' };
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 400, error: 'Expected a JSON object.' };
    throw error;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? null
    : { status: 400, error: 'Expected a JSON object.' };
}

async function runGpuq(command, args) {
  const { JOB_CONTROL_TOKEN, ...environment } = process.env;
  return executeFile(command, args, {
    env: environment,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
}

function downloadHeaders(response, id, key, size) {
  response.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': size,
    'Content-Disposition': `attachment; filename="job-${id}-${key}.log"`,
  });
}

/** Routes with explicit job/log identifiers; paths and commands never come from the browser. */
export function createActions({ config, store, logger = console, runCommand = runGpuq }) {
  async function download(request, response, id, key) {
    if (config.mode === 'demo') {
      const log = await store.getLog(id, key);
      if (log === null) {
        json(request, response, 404, { error: 'Not found.' });
        return;
      }
      const text = Buffer.from(log.text);
      downloadHeaders(response, id, key, text.length);
      response.end(request.method === 'HEAD' ? undefined : text);
      return;
    }

    const source = await store.getLogSource(id, key);
    if (source === null) {
      json(request, response, 404, { error: 'Not found.' });
      return;
    }
    let file;
    try {
      file = await open(source.path, 'r');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      json(request, response, 404, { error: 'Not found.' });
      return;
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        json(request, response, 404, { error: 'Not found.' });
        return;
      }
      downloadHeaders(response, id, key, info.size);
      if (request.method === 'HEAD' || info.size === 0) {
        response.end();
        return;
      }
      // Snapshot the size so an actively growing log does not create an endless download.
      try {
        await pipeline(file.createReadStream({ autoClose: false, start: 0, end: info.size - 1 }), response);
      } catch (error) {
        if (!response.destroyed) logger.error('Log download failed:', error);
        response.destroy();
      }
    } finally {
      await file.close();
    }
  }

  async function cancel(request, response, id) {
    if (config.mode !== 'demo' && !config.jobControlEnabled) {
      json(request, response, 403, { error: 'Job cancellation is disabled.' });
      return;
    }
    if (!sameOrigin(request, config.publicOrigin)) {
      json(request, response, 403, { error: 'Cross-origin cancellation is not allowed.' });
      return;
    }
    if (config.mode !== 'demo' && !authorized(request, config.jobControlToken)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      json(request, response, 401, { error: 'A valid operator token is required.' });
      return;
    }
    const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      json(request, response, 415, { error: 'Content-Type must be application/json.' });
      return;
    }
    const invalidBody = await bodyIsObject(request);
    if (invalidBody) {
      json(request, response, invalidBody.status, { error: invalidBody.error });
      return;
    }
    const job = await store.getJob(id);
    if (job === null) {
      json(request, response, 404, { error: 'Not found.' });
      return;
    }
    if (!CANCELLABLE.has(job.state)) {
      json(request, response, 409, { error: 'This job is no longer cancellable.' });
      return;
    }
    if (config.mode === 'demo') {
      await store.cancelJob(id);
      json(request, response, 200, { accepted: true, id, state: 'cancelled' });
      return;
    }
    await runCommand(config.gpuqCommand, ['cancel', String(id)]);
    json(request, response, 202, { accepted: true, id, state: 'cancellation_requested' });
  }

  return async function handleAction(request, response, pathname) {
    const match = /^\/api\/jobs\/([1-9]\d*)\/(artifacts|cancel|logs\/([a-zA-Z0-9-]+)\/download)$/.exec(pathname);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return false;
    const id = Number(match[1]);
    if (match[2] === 'cancel') {
      if (request.method !== 'POST') methodNotAllowed(request, response, 'POST');
      else await cancel(request, response, id);
    } else if (!['GET', 'HEAD'].includes(request.method)) {
      methodNotAllowed(request, response, 'GET, HEAD');
    } else if (match[2] === 'artifacts') {
      const result = await store.getArtifacts(id);
      json(request, response, result === null ? 404 : 200, result ?? { error: 'Not found.' });
    } else {
      await download(request, response, id, match[3]);
    }
    return true;
  };
}
