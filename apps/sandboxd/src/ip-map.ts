import type { DockerPort } from './docker.ts';
import { log } from './log.ts';
import type { SandboxRow, Store } from './store.ts';

/** Container IP -> sandbox id, kept fresh from docker events; policy is read from the Store per lookup. */
export async function createIpMap(
  store: Store,
  docker: DockerPort,
): Promise<{ sandboxForIp(ip: string): SandboxRow | undefined; stop(): void }> {
  const byIp = new Map<string, string>();
  const forget = (id: string) => {
    for (const [ip, v] of byIp) if (v === id) byIp.delete(ip);
  };
  const learn = async (id: string, cid: string) => {
    try {
      const ip = (await docker.inspect(cid))?.ip;
      forget(id);
      if (ip) byIp.set(ip, id);
    } catch (e) {
      log('warn', 'ip-map inspect failed', { 'sandboxd.id': id, err: String(e) });
    }
  };

  // Subscribe before the boot scan so a start landing mid-scan is not lost.
  const stop = docker.events((e) => {
    const id = e.labels['sandboxd.id'];
    if (id === undefined) return;
    if (e.action === 'start') void learn(id, e.cid);
    else if (e.action === 'die' || e.action === 'destroy') forget(id);
  });
  await Promise.all(
    store
      .all()
      .filter((r) => r.class === 'agent' && r.containerId)
      .map((r) => learn(r.id, r.containerId!)),
  );
  return {
    sandboxForIp: (ip) => {
      const id = byIp.get(ip);
      return id === undefined ? undefined : store.get(id);
    },
    stop,
  };
}
