import { createServer, type Server } from 'node:http';

import { Admission } from './admission.ts';
import { loadConfig } from './config.ts';
import { router, sendJson } from './http.ts';
import { DockerodePort } from './docker.ts';
import { startEgressProxy } from './egress.ts';
import { watchEvents } from './events.ts';
import { applyFirewall, checkFirewall, ensureNetworks, firewallMode } from './network.ts';
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

// Networks first (the egress bind address is the bridge gateway), then rules, then servers.
await ensureNetworks(docker);
const fwMode = firewallMode();
if (fwMode === 'on') await applyFirewall();
else log('warn', 'firewall skipped (local dev only): sandboxes are NOT isolated');

const api = router(config.apiKey);
api.route(
  'GET',
  '/healthz',
  async (_req, res) => {
    store.all();
    const firewall = fwMode === 'on' ? await checkFirewall() : 'skipped';
    sendJson(res, firewall === false ? 503 : 200, {
      ok: firewall !== false,
      store: true,
      docker: await docker.ping(),
      firewall,
    });
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

let closing = false;
/** Listen; on any error log it, and if not yet listening (bridge late, port busy) retry in 5 s. */
function listen(srv: Server, name: string, hp: { host: string; port: number }): Server {
  srv.on('error', (e: NodeJS.ErrnoException) => {
    log('error', `${name} server error`, { code: e.code, message: e.message, ...hp });
    if (!srv.listening && !closing) setTimeout(() => srv.listen(hp.port, hp.host), 5000);
  });
  return srv.listen(hp.port, hp.host, () => log('info', `${name} listening`, { ...hp }));
}

const server = listen(createServer(api.handle), 'sandboxd', config.listen);
const previewServer = listen(
  createPreviewServer({ cfg: config, store, docker }),
  'preview proxy',
  config.previewListen,
);

if (config.apiHost === '')
  log('warn', 'SANDBOXD_API_HOST is empty: agent homes cannot reach the BAIOS API');
const ipMap = await createIpMap(store, docker);
// With the firewall on, networks exist first so the bridge gateway is bindable; on Docker Desktop
// (firewall skipped) it is not, and the retry loop just keeps warning.
const egressServer = listen(startEgressProxy(config, ipMap), 'egress proxy', config.egressListen);

const shutdown = () => {
  closing = true;
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
