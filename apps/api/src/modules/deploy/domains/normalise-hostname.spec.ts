import { describe, expect, it } from 'vitest';

import { normaliseHostname, reservedSuffixes } from './normalise-hostname';

/** The platform's own domains, as `reservedSuffixes` derives them from the environment (R8 step 5). */
const RESERVED = reservedSuffixes({
  appUrl: 'https://app.forge.example',
  customHostnameTarget: 'edge.forge-saas.net',
  previewDomain: 'preview.forge.dev',
  reservedDomains: ['forge.app', 'Status.Forge.IO.'],
  siteDomain: 'forge.site',
});

function refused(input: string) {
  const result = normaliseHostname(input, RESERVED);
  return result.ok ? undefined : result.reason;
}

describe('normaliseHostname', () => {
  it('normalises trim, one trailing dot and upper case to one form', () => {
    for (const input of ['www.acme.com', '  www.acme.com  ', 'www.acme.com.', 'WWW.Acme.COM.']) {
      expect(normaliseHostname(input, RESERVED)).toEqual({
        displayHostname: 'www.acme.com',
        hostname: 'www.acme.com',
        ok: true,
      });
    }
  });

  it('converts an IDN name to its xn-- form, and round-trips the Unicode form for display', () => {
    expect(normaliseHostname('Shop.München.de', RESERVED)).toEqual({
      displayHostname: 'shop.münchen.de',
      hostname: 'shop.xn--mnchen-3ya.de',
      ok: true,
    });
    expect(normaliseHostname('shop.xn--mnchen-3ya.de', RESERVED)).toEqual({
      displayHostname: 'shop.münchen.de',
      hostname: 'shop.xn--mnchen-3ya.de',
      ok: true,
    });
  });

  it('accepts a 63-character label and a 253-character name', () => {
    const label63 = 'a'.repeat(63);
    expect(normaliseHostname(`${label63}.acme.com`, RESERVED).ok).toBe(true);
    const name253 = `${'b'.repeat(61)}.${'c'.repeat(61)}.${'d'.repeat(61)}.${'e'.repeat(58)}.acme.com`;
    expect(name253).toHaveLength(253);
    expect(normaliseHostname(name253, RESERVED).ok).toBe(true);
  });

  describe('invalid-hostname', () => {
    it.each([
      ['an empty string', ''],
      ['only whitespace', '   '],
      ['only a dot', '.'],
      [
        'more than 253 characters',
        `${'b'.repeat(61)}.${'c'.repeat(61)}.${'d'.repeat(61)}.${'e'.repeat(59)}.acme.com`,
      ],
      ['a 64-character label', `${'a'.repeat(64)}.acme.com`],
      ['a leading hyphen', '-www.acme.com'],
      ['a trailing hyphen', 'www-.acme.com'],
      ['a wildcard', '*.acme.com'],
      ['an IPv4 literal', '1.2.3.4'],
      ['an IPv4 literal in another notation', '0x7f.1'],
      ['a bracketed IPv6 literal', '[::1]'],
      ['a bare IPv6 literal', '::1'],
      ['localhost', 'localhost'],
      ['a name under localhost', 'shop.localhost'],
      ['a single label', 'intranet'],
      ['an underscore', 'a_b.acme.com'],
      ['an empty label', 'www..acme.com'],
      ['two trailing dots', 'www.acme.com..'],
      ['a space', 'www acme.com'],
      ['an xn-- label that is not valid Punycode', 'xn--zz.acme.com'],
      ['a numeric top-level label', 'www.acme.123'],
    ])('refuses %s', (_name, input) => {
      expect(refused(input)).toBe('invalid-hostname');
    });
  });

  it('refuses apex-not-supported for a two-label name', () => {
    expect(refused('acme.com')).toBe('apex-not-supported');
    expect(refused('ACME.com.')).toBe('apex-not-supported');
  });

  describe('reserved-hostname', () => {
    it.each([
      ['the product host', 'app.forge.example'],
      ['under the product host', 'x.app.forge.example'],
      ['PREVIEW_DOMAIN', 'preview.forge.dev'],
      ['under PREVIEW_DOMAIN', 'abc.preview.forge.dev'],
      ['under SITE_DOMAIN', 'my-site-aaaaaaaa.forge.site'],
      ['the target', 'edge.forge-saas.net'],
      ['under the target parent', 'other.forge-saas.net'],
      ['under a RESERVED_DOMAINS entry', 'www.forge.app'],
      ['a RESERVED_DOMAINS entry, normalised', 'status.forge.io'],
      ['under a RESERVED_DOMAINS entry, normalised', 'a.status.forge.io'],
    ])('refuses %s', (_name, input) => {
      expect(refused(input)).toBe('reserved-hostname');
    });

    it('compares whole labels, so notforge.app is not under forge.app', () => {
      expect(normaliseHostname('www.notforge.app', RESERVED)).toMatchObject({ ok: true });
      expect(normaliseHostname('forge.app.acme.com', RESERVED)).toMatchObject({ ok: true });
      expect(normaliseHostname('x.xpreview.forge.dev', RESERVED)).toMatchObject({ ok: true });
    });

    it('checks the apex before the reservation, in R8 order', () => {
      expect(refused('forge.site')).toBe('apex-not-supported');
      expect(refused('forge.app')).toBe('apex-not-supported');
    });
  });
});

describe('reservedSuffixes', () => {
  it('collects the product host, preview and site domains, the target parent and the extras', () => {
    expect(RESERVED).toEqual([
      'app.forge.example',
      'preview.forge.dev',
      'forge.site',
      'forge-saas.net',
      'forge.app',
      'status.forge.io',
    ]);
  });

  it('skips what is absent, blank, not a URL, or a single-label parent', () => {
    expect(
      reservedSuffixes({
        appUrl: 'not a url',
        customHostnameTarget: 'saas.net',
        previewDomain: 'preview.localhost',
        reservedDomains: ['', '  '],
      }),
    ).toEqual(['preview.localhost']);
    expect(
      reservedSuffixes({ appUrl: 'http://localhost:3000', previewDomain: 'p.forge.dev' }),
    ).toEqual(['p.forge.dev']);
    expect(reservedSuffixes({})).toEqual([]);
  });
});
