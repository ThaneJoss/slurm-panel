import { once } from 'node:events';
import { readConfig } from './config.js';
import { createApp } from './app.js';

const config = readConfig();
const store = config.mode === 'demo'
  ? (await import('../data/demo.js')).createDemoStore()
  : (await import('../data/gpuq.js')).createGpuqStore({
    databasePath: config.databasePath, metricsFile: config.metricsFile, etaStateFile: config.etaStateFile,
  });
const server = createApp({ config, store });

try {
  server.listen(config.port, config.host);
  await once(server, 'listening');
} catch (error) {
  store.close();
  throw error;
}

const address = server.address();
const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
console.log(`${config.title} (${config.mode}) listening on http://${host}:${address.port}`);

let sampleTimer;
let stopping = false;
let sampling = Promise.resolve();
function sampleProgress() {
  sampling = store.sampleProgress().catch((error) => console.error('Progress sampling failed:', error));
  sampling.finally(() => {
    if (!stopping) sampleTimer = setTimeout(sampleProgress, 5000);
  });
}
if (store.sampleProgress) sampleProgress();

function shutdown() {
  stopping = true;
  clearTimeout(sampleTimer);
  server.close(() => sampling.finally(() => store.close()));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
