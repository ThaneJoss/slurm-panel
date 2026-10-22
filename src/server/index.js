import { once } from 'node:events';
import { readConfig } from './config.js';
import { createApp } from './app.js';

const config = readConfig();
const store = config.mode === 'demo'
  ? (await import('../data/demo.js')).createDemoStore()
  : (await import('../data/gpuq.js')).createGpuqStore({ databasePath: config.databasePath, metricsFile: config.metricsFile });
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

function shutdown() {
  server.close(() => store.close());
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
