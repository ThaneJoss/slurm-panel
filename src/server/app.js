import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { publicConfig } from './config.js';
import { createActions } from './actions.js';

const publicDirectory = new URL('../../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/dom.js', ['dom.js', 'text/javascript; charset=utf-8']],
  ['/detail.js', ['detail.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/detail.css', ['detail.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

function send(request, response, status, body, contentType = 'application/json; charset=utf-8') {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': content.length,
  });
  response.end(request.method === 'HEAD' ? undefined : content);
}

/** Build the dashboard HTTP server; callers own the store's lifecycle. */
export function createApp({ config, store, logger = console, runCommand }) {
  const handleAction = createActions({ config, store, logger, runCommand });
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
    ].join('; '));

    let url;
    let pathname;
    try {
      url = new URL(request.url, 'http://localhost');
      pathname = url.pathname;
    } catch {
      send(request, response, 400, { error: 'Invalid request URL.' });
      return;
    }

    try {
      if (await handleAction(request, response, pathname)) return;
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        send(request, response, 405, { error: 'Method not allowed.' });
        return;
      }
      const asset = assets.get(pathname);
      if (asset) {
        const [filename, contentType] = asset;
        send(request, response, 200, await readFile(new URL(filename, publicDirectory)), contentType);
        return;
      }
      if (pathname === '/api/config') {
        send(request, response, 200, publicConfig(config));
        return;
      }
      if (pathname === '/api/health') {
        send(request, response, 200, { status: 'ok', mode: config.mode });
        return;
      }
      if (pathname === '/api/jobs') {
        send(request, response, 200, await store.listJobs(url.searchParams));
        return;
      }

      const route = /^\/api\/jobs\/([1-9]\d*)(?:\/logs\/([a-zA-Z0-9-]+))?$/.exec(pathname);
      if (route && Number.isSafeInteger(Number(route[1]))) {
        const id = Number(route[1]);
        const result = route[2] ? await store.getLog(id, route[2]) : await store.getJob(id);
        send(request, response, result === null ? 404 : 200, result ?? { error: 'Not found.' });
        return;
      }
      send(request, response, 404, { error: 'Not found.' });
    } catch (error) {
      if (error.statusCode === 400) {
        send(request, response, 400, { error: error.message });
        return;
      }
      logger.error('Dashboard request failed:', error);
      send(request, response, 503, { error: 'Unable to read dashboard data. See the server log.' });
    }
  });
}
