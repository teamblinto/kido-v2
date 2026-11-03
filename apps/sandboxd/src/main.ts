import { createServer } from 'node:http';

import { Admission } from './admission.ts';
import { loadConfig } from './config.ts';
import { router, sendJson } from './http.ts';
import { DockerodePort } from './docker.ts';
import { startEgressProxy } from './egress.ts';
import { watchEvents } from './events.ts';
import { createIpMap } from './ip-map.ts';
import { log } from './log.ts';
import { createPreviewServer, registerPreviewRoutes } from './preview.ts';
import { registerSandboxRoutes } from './sandboxes.ts';
import { Store } from './store.ts';
import { clearStaleSessions, registerToolboxRoutes } from './toolbox.ts';

const config = loadConfig(process.env);
const store = new Store(config.dataDir);
const docker = new DockerodePort();
const admission = new Admission({ cfg: config, store, docker });

const api = router(config.apiKey);
// firewall checks are wired in by later tasks.
api.route(
  'GET',
  '/healthz',
  async (_req, res) => {
    store.all();
    sendJson(res, 200, { ok: true, store: true, docker: await docker.ping() });
  },
  { auth: false },
);
registerSandboxRoutes(api, { cfg: config, store, docker, admission });
registerToolboxRoutes(api, { cfg: config, store, docker });
registerPreviewRoutes(api, { cfg: config, store });
await clearStaleSessions(store, docker);

const unwatch = watchEvents(docker, admission);
await admission.recover();
const timer = setInterval(() => void admission.tick(), 2000);
void admission.tick();

const server = createServer(api.handle).listen(config.listen.port, config.listen.host, () => {
  log('info', 'sandboxd listening', { node: config.nodeId, ...config.listen });
});

const previewServer = createPreviewServer({ cfg: config, store, docker }).listen(
  config.previewListen.port,
  config.previewListen.host,
  () => {
    log('info', 'preview proxy listening', { ...config.previewListen });
  },
);

if (config.apiHost === '') log('warn', 'SANDBOXD_API_HOST is empty: agent homes cannot reach the BAIOS API');
const ipMap = await createIpMap(store, docker);
const egressServer = startEgressProxy(config, ipMap);
// The bridge address only exists once networks are created; tolerate its absence until then.
egressServer.once('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRNOTAVAIL') throw e;
  log('warn', 'egress proxy not listening: bind address unavailable', { ...config.egressListen });
});
egressServer.listen(config.egressListen.port, config.egressListen.host, () => {
  log('info', 'egress proxy listening', { ...config.egressListen });
});

const shutdown = () => {
  ipMap.stop();
  egressServer.close();
  clearInterval(timer);
  unwatch();
  server.close();
  previewServer.close();
  store.close();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
