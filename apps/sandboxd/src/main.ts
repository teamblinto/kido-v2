import { createServer } from 'node:http';

import { loadConfig } from './config.ts';
import { router, sendJson } from './http.ts';
import { log } from './log.ts';
import { Store } from './store.ts';

const config = loadConfig(process.env);
const store = new Store(config.dataDir);

const api = router();
// docker/firewall checks are wired in by later tasks.
api.route('GET', '/healthz', (_req, res) => {
  store.all();
  sendJson(res, 200, { ok: true, store: true });
  return Promise.resolve();
});

createServer(api.handle).listen(config.listen.port, config.listen.host, () => {
  log('info', 'sandboxd listening', { node: config.nodeId, ...config.listen });
});
