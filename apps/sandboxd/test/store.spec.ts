import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, type SandboxRow } from '../src/store.ts';

const row = (id: string, labels: Record<string, string> = {}): SandboxRow => ({
  id,
  containerId: null,
  image: 'img',
  class: 'project',
  labels,
  desired: 'queued',
  networkAllow: null,
  networkBlockAll: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  queuedAt: null,
});

describe('Store', () => {
  it('round-trips, filters by labels, updates, removes, survives reopen', () => {
    const d = mkdtempSync(join(tmpdir(), 'sbxd-'));
    const s = new Store(d);
    s.insert(row('a', { a: '1', b: '2' }));
    s.insert(row('b', { a: '2' }));
    expect(s.get('a')).toEqual(row('a', { a: '1', b: '2' }));
    expect(s.get('zz')).toBeUndefined();
    expect(s.byLabels({ a: '1' }).map((r) => r.id)).toEqual(['a']);
    expect(s.byLabels({ a: '1', b: '3' })).toEqual([]);
    s.setLabels('b', { x: 'y' });
    s.setState('b', 'started');
    s.setNetwork('b', ['h.com'], true);
    s.close();
    const s2 = new Store(d);
    expect(s2.get('b')).toMatchObject({
      labels: { x: 'y' },
      desired: 'started',
      networkAllow: ['h.com'],
      networkBlockAll: true,
    });
    s2.remove('a');
    expect(s2.all().map((r) => r.id)).toEqual(['b']);
    s2.close();
  });
});
