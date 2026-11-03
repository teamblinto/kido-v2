import type { BrokerRouteResult } from './broker-client.ts';
import type { RouteRecord } from './route-verify.ts';
import { createTlsAsk } from './tls-ask.ts';

const LABEL = '0123456789abcdef0123';
const host = (port: number, label = LABEL) => `${label}-${String(port)}.preview.example.com`;
const route = { label: LABEL, ports: [3000] } as RouteRecord;

describe('createTlsAsk', () => {
  const ask = (answer: BrokerRouteResult) => {
    const getRoute = vi.fn((_label: string, _ctx: { host: string }) => Promise.resolve(answer));
    return { allowed: createTlsAsk({ getRoute, previewDomain: 'preview.example.com' }), getRoute };
  };

  it('approves a live route on its declared port only, asking the broker as the gateway does', async () => {
    const { allowed, getRoute } = ask({ kind: 'route', route });
    expect(await allowed(host(3000))).toBe(true);
    expect(getRoute).toHaveBeenCalledWith(LABEL, { host: host(3000) });
    expect(await allowed(host(3001))).toBe(false);
  });

  it('refuses names the gateway would refuse without asking the broker', async () => {
    const { allowed, getRoute } = ask({ kind: 'route', route });
    for (const d of [
      'preview.example.com',
      'evil.com',
      `zz${LABEL}-3000.preview.example.com`,
      `${LABEL}-80.preview.example.com`,
      `x.${host(3000)}`,
    ])
      expect(await allowed(d)).toBe(false);
    expect(getRoute).not.toHaveBeenCalled();
  });

  it('refuses unknown labels and a broker outage', async () => {
    expect(await ask({ kind: 'refused' }).allowed(host(3000))).toBe(false);
    expect(await ask({ kind: 'retryable', reason: 'down' }).allowed(host(3000))).toBe(false);
  });

  it.each(['waking', 'unauthorised'] as const)(
    '%s: the label exists but the port is unknown, so only a few hostnames per label',
    async (kind) => {
      const { allowed } = ask({ kind });
      for (const p of [3000, 3001, 3002]) expect(await allowed(host(p))).toBe(true);
      expect(await allowed(host(3000))).toBe(true); // a repeat is no new certificate
      expect(await allowed(host(3003))).toBe(false);
      expect(await allowed(host(3003, 'f'.repeat(20)))).toBe(true);
    },
  );
});
