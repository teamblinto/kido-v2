import { describe, expect, it } from 'vitest';

import { MAX_CNAME_HOPS } from '../../src/modules/deploy/domains/dns.port';

import { FakeDns } from './fake-dns';

describe('FakeDns', () => {
  it('answers empty for a name or type that was never set', async () => {
    const dns = new FakeDns().set('app.acme.com', 'TXT', ['v=spf1']);
    expect(await dns.resolveTxt('nothing.acme.com')).toEqual({ kind: 'empty' });
    expect(await dns.resolveCaa('app.acme.com')).toEqual({ kind: 'empty' });
    expect(await dns.resolveSoaOwner('app.acme.com')).toEqual({ kind: 'empty' });
    expect(await dns.resolveCnameChain('app.acme.com')).toEqual({ kind: 'empty' });
    expect(await dns.set('x.acme.com', 'TXT', []).resolveTxt('x.acme.com')).toEqual({
      kind: 'empty',
    });
  });

  it('answers what was set, comparing names without case or a trailing dot', async () => {
    const caa = [{ critical: false, tag: 'issue', value: 'letsencrypt.org' }];
    const dns = new FakeDns()
      .set('_forge-challenge.App.Acme.com.', 'TXT', ['forge-verify=abc'])
      .set('acme.com', 'CAA', caa)
      .set('acme.com', 'SOA', 'ACME.com.');
    expect(await dns.resolveTxt('_forge-challenge.app.acme.com')).toEqual({
      kind: 'answer',
      records: ['forge-verify=abc'],
    });
    expect(await dns.resolveCaa('acme.com')).toEqual({ kind: 'answer', records: caa });
    expect(await dns.resolveSoaOwner('acme.com')).toEqual({ kind: 'answer', owner: 'acme.com' });
    expect(dns.queries.map((query) => query.type)).toEqual(['TXT', 'CAA', 'SOA']);
  });

  it('follows a CNAME chain hop by hop, capped at MAX_CNAME_HOPS', async () => {
    const dns = new FakeDns()
      .set('app.acme.com', 'CNAME', 'cdn.acme.net')
      .set('cdn.acme.net', 'CNAME', 'edge.forge-saas.net.');
    expect(await dns.resolveCnameChain('app.acme.com')).toEqual({
      chain: ['cdn.acme.net', 'edge.forge-saas.net'],
      kind: 'answer',
    });

    dns.set('a.loop.com', 'CNAME', 'b.loop.com').set('b.loop.com', 'CNAME', 'a.loop.com');
    const loop = await dns.resolveCnameChain('a.loop.com');
    expect(loop.kind === 'answer' && loop.chain).toHaveLength(MAX_CNAME_HOPS);
  });

  it('answers unavailable at a down name, including a chain through it, until available', async () => {
    const dns = new FakeDns()
      .set('app.acme.com', 'CNAME', 'cdn.acme.net')
      .set('cdn.acme.net', 'CNAME', 'edge.forge-saas.net')
      .unavailable('cdn.acme.net');
    expect(await dns.resolveCnameChain('app.acme.com')).toEqual({ kind: 'unavailable' });
    expect(await dns.resolveTxt('cdn.acme.net')).toEqual({ kind: 'unavailable' });
    dns.available('cdn.acme.net');
    expect((await dns.resolveCnameChain('app.acme.com')).kind).toBe('answer');
  });

  it('deletes one type, a whole name, or everything', async () => {
    const dns = new FakeDns()
      .set('app.acme.com', 'CNAME', 'edge.forge-saas.net')
      .set('app.acme.com', 'TXT', ['x'])
      .delete('app.acme.com', 'CNAME');
    expect(await dns.resolveCnameChain('app.acme.com')).toEqual({ kind: 'empty' });
    expect((await dns.resolveTxt('app.acme.com')).kind).toBe('answer');
    dns.delete('app.acme.com').delete('never.acme.com', 'TXT');
    expect(await dns.resolveTxt('app.acme.com')).toEqual({ kind: 'empty' });

    dns.set('b.acme.com', 'TXT', ['y']).unavailable('c.acme.com');
    dns.reset();
    expect(dns.queries).toEqual([]);
    expect(await dns.resolveTxt('b.acme.com')).toEqual({ kind: 'empty' });
    expect(await dns.resolveTxt('c.acme.com')).toEqual({ kind: 'empty' });
  });
});
