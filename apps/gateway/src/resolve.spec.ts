import { describe, expect, it } from 'vitest';

import { resolveHost } from './resolve.ts';

const DOMAIN = 'forge-preview.localhost';
const LABEL_20 = '0123456789abcdef0123'; // 20 hex chars, the pre-007 floor
const LABEL_64 = 'a'.repeat(64); // ceiling

describe('resolveHost', () => {
  it('parses a valid label and port', () => {
    expect(resolveHost(`${LABEL_20}-5173.${DOMAIN}`, DOMAIN)).toEqual({
      ok: true,
      hostname: `${LABEL_20}-5173.${DOMAIN}`,
      label: LABEL_20,
      port: 5173,
    });
  });

  it('parses a 64-char label at the ceiling', () => {
    expect(resolveHost(`${LABEL_64}-1024.${DOMAIN}`, DOMAIN)).toEqual({
      ok: true,
      hostname: `${LABEL_64}-1024.${DOMAIN}`,
      label: LABEL_64,
      port: 1024,
    });
  });

  it('strips the gateway listening port carried on the Host header', () => {
    expect(resolveHost(`${LABEL_20}-5173.${DOMAIN}:3200`, DOMAIN)).toEqual({
      ok: true,
      hostname: `${LABEL_20}-5173.${DOMAIN}`,
      label: LABEL_20,
      port: 5173,
    });
  });

  it('is case-insensitive on the hostname', () => {
    expect(resolveHost(`${LABEL_20}-5173.${DOMAIN}`.toUpperCase(), DOMAIN)).toEqual({
      ok: true,
      hostname: `${LABEL_20}-5173.${DOMAIN}`,
      label: LABEL_20,
      port: 5173,
    });
  });

  it('refuses a bad suffix (wrong preview domain)', () => {
    expect(resolveHost(`${LABEL_20}-5173.example.com`, DOMAIN)).toEqual({ ok: false });
  });

  it('refuses a missing port', () => {
    expect(resolveHost(`${LABEL_20}.${DOMAIN}`, DOMAIN)).toEqual({ ok: false });
  });

  it('refuses a malformed label (too short)', () => {
    expect(resolveHost(`0123456789abcdef012-5173.${DOMAIN}`, DOMAIN)).toEqual({ ok: false });
  });

  it('refuses a malformed label (too long)', () => {
    expect(resolveHost(`${'a'.repeat(65)}-5173.${DOMAIN}`, DOMAIN)).toEqual({ ok: false });
  });

  it('refuses a malformed label (non-hex characters)', () => {
    expect(resolveHost(`${'g'.repeat(20)}-5173.${DOMAIN}`, DOMAIN)).toEqual({ ok: false });
  });

  it('refuses a port below 1024', () => {
    expect(resolveHost(`${LABEL_20}-1023.${DOMAIN}`, DOMAIN)).toEqual({ ok: false });
  });

  it('refuses a port above 65535', () => {
    expect(resolveHost(`${LABEL_20}-65536.${DOMAIN}`, DOMAIN)).toEqual({ ok: false });
  });

  it('refuses an empty host', () => {
    expect(resolveHost('', DOMAIN)).toEqual({ ok: false });
  });
});

describe('resolveHost with a SITE_DOMAIN (contracts/site-serving.md § 1)', () => {
  const SITE = 'forge-site.localhost';

  it('resolves {label}.{SITE_DOMAIN} to a site label, stripping the listening port', () => {
    expect(resolveHost(`My-Site-7f3a.${SITE}:3200`, DOMAIN, SITE)).toEqual({
      hostname: `my-site-7f3a.${SITE}`,
      kind: 'site',
      label: 'my-site-7f3a',
      ok: true,
    });
    expect(resolveHost(`a.${SITE}`, DOMAIN, SITE)).toMatchObject({ kind: 'site', label: 'a' });
    expect(resolveHost(`${'a'.repeat(63)}.${SITE}`, DOMAIN, SITE)).toMatchObject({ kind: 'site' });
  });

  it('checks the preview pattern first', () => {
    expect(resolveHost(`${LABEL_20}-5173.${DOMAIN}`, DOMAIN, SITE)).toEqual({
      hostname: `${LABEL_20}-5173.${DOMAIN}`,
      label: LABEL_20,
      ok: true,
      port: 5173,
    });
  });

  it.each([
    `-site.${SITE}`,
    `site-.${SITE}`,
    `${'a'.repeat(64)}.${SITE}`,
    `a.b.${SITE}`,
    `my_site.${SITE}`,
    SITE,
    `.${SITE}`,
    `site.x${SITE}`,
  ])('refuses %s', (host) => {
    expect(resolveHost(host, DOMAIN, SITE)).toEqual({ ok: false });
  });

  it('serves no site host when SITE_DOMAIN is unset', () => {
    expect(resolveHost(`site.${SITE}`, DOMAIN)).toEqual({ ok: false });
  });
});

describe('resolveHost with custom domains (contracts/domain-serving.md § 1)', () => {
  const SITE = 'forge-site.localhost';

  it('resolves any other valid hostname to a domain, lowercased and without its port', () => {
    expect(resolveHost('WWW.Acme-Example.com:3200', DOMAIN, SITE, true)).toEqual({
      hostname: 'www.acme-example.com',
      kind: 'domain',
      ok: true,
    });
    expect(resolveHost('shop.xn--bcher-kva.example', DOMAIN, SITE, true)).toEqual({
      hostname: 'shop.xn--bcher-kva.example',
      kind: 'domain',
      ok: true,
    });
  });

  it('keeps preview and site precedence', () => {
    expect(resolveHost(`${LABEL_20}-5173.${DOMAIN}`, DOMAIN, SITE, true)).toEqual({
      hostname: `${LABEL_20}-5173.${DOMAIN}`,
      label: LABEL_20,
      ok: true,
      port: 5173,
    });
    expect(resolveHost(`my-site.${SITE}`, DOMAIN, SITE, true)).toEqual({
      hostname: `my-site.${SITE}`,
      kind: 'site',
      label: 'my-site',
      ok: true,
    });
  });

  it('serves no domain unless custom domains are configured', () => {
    expect(resolveHost('www.acme-example.com', DOMAIN, SITE)).toEqual({ ok: false });
    expect(resolveHost('www.acme-example.com', DOMAIN, SITE, false)).toEqual({ ok: false });
    // Custom domains serve a site: without a site domain there are none.
    expect(resolveHost('www.acme-example.com', DOMAIN, undefined, true)).toEqual({ ok: false });
  });

  it.each([
    '',
    ':3200',
    'acme',
    'www..acme.com',
    '.acme.com',
    'www.acme.com.',
    '-www.acme.com',
    'www-.acme.com',
    'www_x.acme.com',
    '*.acme.com',
    `${'a'.repeat(64)}.acme.com`,
    `${'a.'.repeat(126)}com`,
    '127.0.0.1',
    '10.0.0.1:80',
    '[::1]:3200',
    'www.acme.0x1f',
    'app.localhost',
    'www.acme.com@evil.example',
    'www.acme.com/x',
    'www.ac me.com',
    'www.äcme.com',
  ])('refuses the malformed host %j', (host) => {
    expect(resolveHost(host, DOMAIN, SITE, true)).toEqual({ ok: false });
  });

  it('never treats a name under a platform domain as a custom domain', () => {
    const PREVIEW = 'forge-preview.example';
    const SITES = 'forge-site.example';
    for (const host of [
      `a.b.${SITES}`,
      `-bad-.${SITES}`,
      SITES,
      `evil.${PREVIEW}`,
      `${LABEL_20}-80.${PREVIEW}`,
      PREVIEW,
    ]) {
      expect({ host, result: resolveHost(host, PREVIEW, SITES, true) }).toEqual({
        host,
        result: { ok: false },
      });
    }
  });

  it('accepts a name that only looks like a platform domain by suffix, not by labels', () => {
    expect(resolveHost('www.notforge-site.example', DOMAIN, 'forge-site.example', true)).toEqual({
      hostname: 'www.notforge-site.example',
      kind: 'domain',
      ok: true,
    });
  });
});
