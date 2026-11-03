import { describe, expect, it } from 'vitest';

import { siteLabel, slugify, type RandomSource } from './site-label';

/** The DNS label rule `project_sites.site_label` and the gateway's resolver both hold (R10). */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SUFFIX = /-[a-z2-7]{8}$/;

/** A fixed random source: the same five bytes every call, so the output is deterministic. */
function fixed(bytes: number[]): RandomSource {
  return (size) => {
    expect(size).toBe(5);
    return Buffer.from(bytes);
  };
}

const ZERO = fixed([0, 0, 0, 0, 0]);
const PREVIEW = '0123456789abcdef0123456789abcdef';

describe('siteLabel', () => {
  it('is the slug of the name plus 8 lowercase base32 characters from the injected source', () => {
    expect(siteLabel('My Portfolio', PREVIEW, ZERO)).toBe('my-portfolio-aaaaaaaa');
    expect(siteLabel('My Portfolio', PREVIEW, fixed([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe(
      'my-portfolio-77777777',
    );
    // RFC 4648 over 0x00 0x44 0x32 0x14 0xc7: 00000 00001 00010 00011 00100 00101 00110 00111
    expect(siteLabel('x', PREVIEW, fixed([0x00, 0x44, 0x32, 0x14, 0xc7]))).toBe('x-abcdefgh');
  });

  it('defaults to a real random source', () => {
    const one = siteLabel('Site', PREVIEW);
    const two = siteLabel('Site', PREVIEW);
    expect(one).toMatch(/^site-[a-z2-7]{8}$/);
    expect(one).not.toBe(two);
  });

  it('caps the slug at 40 characters, with no trailing hyphen left by the cut', () => {
    const label = siteLabel(`${'a'.repeat(39)} b${'c'.repeat(50)}`, PREVIEW, ZERO);
    expect(label).toBe(`${'a'.repeat(39)}-aaaaaaaa`);
    expect(slugify('x'.repeat(200))).toHaveLength(40);
  });

  it.each([
    ['all punctuation', '!!!---???...'],
    ['emoji', '🚀🔥✨'],
    ['200 characters', 'Z'.repeat(200)],
    ['mixed 200', '-Hello, World! '.repeat(14)],
    ['accents', 'Café Crème Brûlée'],
    ['whitespace', '   \t\n  '],
    ['empty', ''],
    ['leading and trailing hyphens', '--x--'],
    ['punycode-looking', 'xn--abc'],
    ['non-latin', 'Проект 東京'],
  ])('always matches the DNS label rule, for %s', (_label, name) => {
    for (const bytes of [
      [0, 0, 0, 0, 0],
      [0xff, 0xff, 0xff, 0xff, 0xff],
      [0x12, 0x34, 0x56, 0x78, 0x9a],
    ]) {
      const label = siteLabel(name, PREVIEW, fixed(bytes));
      expect(label).toMatch(DNS_LABEL);
      expect(label).toMatch(SUFFIX);
      expect(label.length).toBeLessThanOrEqual(49);
    }
  });

  it('falls back to "site" when nothing of the name survives', () => {
    expect(siteLabel('🚀🔥', PREVIEW, ZERO)).toBe('site-aaaaaaaa');
    expect(siteLabel('Café', PREVIEW, ZERO)).toBe('cafe-aaaaaaaa');
    expect(siteLabel('xn--abc', PREVIEW, ZERO)).toBe('xn-abc-aaaaaaaa');
  });

  it('never contains the preview label, even when the project is named after it', () => {
    const named = siteLabel(PREVIEW, PREVIEW, ZERO);
    expect(named).not.toContain(PREVIEW);
    expect(named).toBe('site-aaaaaaaa');
    const around = siteLabel(`My ${PREVIEW.toUpperCase()} site`, PREVIEW, ZERO);
    expect(around).not.toContain(PREVIEW);
    expect(around).toMatch(DNS_LABEL);
  });

  it('keeps a name that merely resembles hex', () => {
    expect(siteLabel('deadbeef', PREVIEW, ZERO)).toBe('deadbeef-aaaaaaaa');
  });
});
