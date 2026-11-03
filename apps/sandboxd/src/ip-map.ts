import type { DockerPort } from './docker.ts';
import { log } from './log.ts';
import type { SandboxRow, Store } from './store.ts';

const RESYNC_MS = 60_000;

/**
 * Container IP -> sandbox id, kept fresh from docker events and a periodic re-sync; policy is
 * read from the Store per lookup.
 * shortcut: DockerPort.events exposes no reconnect signal, so a missed event is repaired by the
 * 60 s re-sync, not immediately; add an onReconnect hook to DockerPort to make it instant.
 */
export async function createIpMap(
  store: Store,
  docker: DockerPort,
): Promise<{ sandboxForIp(ip: string): SandboxRow | undefined; stop(): void }> {
  const byIp = new Map<string, string>();
  // Per-sandbox generation: any learn/forget supersedes in-flight learns for that sandbox.
  const gen = new Map<string, number>();
  const bump = (id: string) => {
    const g = (gen.get(id) ?? 0) + 1;
    gen.set(id, g);
    return g;
  };
  const drop = (id: string) => {
    for (const [ip, v] of byIp) if (v === id) byIp.delete(ip);
  };
  const forget = (id: string) => {
    bump(id);
    drop(id);
  };
  const learn = async (id: string, cid: string) => {
    const g = bump(id);
    try {
      const ip = (await docker.inspect(cid))?.ip;
      if (gen.get(id) !== g) return;
      drop(id);
      if (ip) byIp.set(ip, id);
    } catch (e) {
      log('warn', 'ip-map inspect failed', { 'sandboxd.id': id, err: String(e) });
    }
  };
  const sync = async () => {
    const rows = store.all().filter((r) => r.class === 'agent' && r.containerId);
    const live = new Set(rows.map((r) => r.id));
    for (const id of new Set(byIp.values())) if (!live.has(id)) forget(id);
    await Promise.all(rows.map((r) => learn(r.id, r.containerId!)));
  };

  // Subscribe before the boot scan so a start landing mid-scan is not lost.
  const unsub = docker.events((e) => {
    const id = e.labels['sandboxd.id'];
    if (id === undefined) return;
    if (e.action === 'start') void learn(id, e.cid);
    else if (e.action === 'die' || e.action === 'destroy') forget(id);
  });
  await sync();
  const timer = setInterval(() => void sync().catch(() => undefined), RESYNC_MS);
  timer.unref();
  return {
    sandboxForIp: (ip) => {
      const id = byIp.get(ip);
      return id === undefined ? undefined : store.get(id);
    },
    stop: () => {
      clearInterval(timer);
      unsub();
    },
  };
}
