import { createServer } from 'node:http';

import { loadConfig } from './config.ts';
import { router, sendJson } from './http.ts';
import { DockerodePort } from './docker.ts';
import { log } from './log.ts';
import { Store } from './store.ts';

const config = loadConfig(process.env);
const store = new Store(config.dataDir);
const docker = new DockerodePort();

const api = router();
// firewall checks are wired in by later tasks.
api.route('GET', '/healthz', async (_req, res) => {
  store.all();
  sendJson(res, 200, { ok: true, store: true, docker: await docker.ping() });
});

createServer(api.handle).listen(config.listen.port, config.listen.host, () => {
  log('info', 'sandboxd listening', { node: config.nodeId, ...config.listen });
});
