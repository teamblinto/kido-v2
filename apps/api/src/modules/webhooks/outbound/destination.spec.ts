import { describe, expect, it } from 'vitest';

import { isAllowedAddress, parseEndpointUrl } from './destination';

/**
 * Every special-use range of research R8, with one address at the low edge, one inside and one at
 * the high edge. Each is refused, for IPv4 and IPv6 alike.
 */
const REFUSED: readonly (readonly [range: string, low: string, inside: string, high: string])[] = [
  ['0.0.0.0/8', '0.0.0.0', '0.1.2.3', '0.255.255.255'],
  ['10.0.0.0/8', '10.0.0.0', '10.0.0.1', '10.255.255.255'],
  ['100.64.0.0/10', '100.64.0.0', '100.100.1.1', '100.127.255.255'],
  ['127.0.0.0/8', '127.0.0.0', '127.0.0.1', '127.255.255.255'],
  ['169.254.0.0/16', '169.254.0.0', '169.254.169.254', '169.254.255.255'],
  ['172.16.0.0/12', '172.16.0.0', '172.20.1.1', '172.31.255.255'],
  ['192.0.0.0/24', '192.0.0.0', '192.0.0.8', '192.0.0.255'],
  ['192.0.2.0/24', '192.0.2.0', '192.0.2.10', '192.0.2.255'],
  ['192.88.99.0/24', '192.88.99.0', '192.88.99.1', '192.88.99.255'],
  ['192.168.0.0/16', '192.168.0.0', '192.168.1.1', '192.168.255.255'],
  ['198.18.0.0/15', '198.18.0.0', '198.18.5.5', '198.19.255.255'],
  ['198.51.100.0/24', '198.51.100.0', '198.51.100.7', '198.51.100.255'],
  ['203.0.113.0/24', '203.0.113.0', '203.0.113.9', '203.0.113.255'],
  ['224.0.0.0/4', '224.0.0.0', '232.1.1.1', '239.255.255.255'],
  ['240.0.0.0/4', '240.0.0.0', '250.1.1.1', '255.255.255.254'],
  ['255.255.255.255/32', '255.255.255.255', '255.255.255.255', '255.255.255.255'],
  ['::/128', '::', '::', '::'],
  ['::1/128', '::1', '::1', '::1'],
  ['64:ff9b::/96', '64:ff9b::', '64:ff9b::a00:1', '64:ff9b::ffff:ffff'],
  ['100::/64', '100::', '100::1', '100::ffff:ffff:ffff:ffff'],
  ['2001::/23', '2001::', '2001:100::1', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001:db8::/32', '2001:db8::', '2001:db8::1', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2002::/16', '2002::', '2002:a00:1::1', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['fc00::/7', 'fc00::', 'fd12:3456::1', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['fe80::/10', 'fe80::', 'fe80::1', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['ff00::/8', 'ff00::', 'ff02::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
];

describe('isAllowedAddress', () => {
  it.each(REFUSED)('refuses %s at both edges and inside', (_range, low, inside, high) => {
    expect(isAllowedAddress(low)).toBe(false);
    expect(isAllowedAddress(inside)).toBe(false);
    expect(isAllowedAddress(high)).toBe(false);
  });

  it('refuses IPv4-mapped IPv6 forms of refused IPv4 addresses', () => {
    expect(isAllowedAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isAllowedAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isAllowedAddress('::ffff:169.254.169.254')).toBe(false);
  });

  it('allows public addresses', () => {
    expect(isAllowedAddress('1.1.1.1')).toBe(true);
    expect(isAllowedAddress('8.8.8.8')).toBe(true);
    expect(isAllowedAddress('2606:4700::1111')).toBe(true);
  });

  it('allows the addresses just outside a refused range', () => {
    expect(isAllowedAddress('11.0.0.0')).toBe(true);
    expect(isAllowedAddress('100.128.0.0')).toBe(true);
    expect(isAllowedAddress('172.32.0.0')).toBe(true);
  });

  it('refuses a string that is not an IP', () => {
    expect(isAllowedAddress('not-an-ip')).toBe(false);
    expect(isAllowedAddress('')).toBe(false);
  });
});

describe('parseEndpointUrl', () => {
  const https = { allowHttp: false } as const;

  it.each([
    ['unparseable input', 'not a url'],
    ['more than 2,048 characters', `https://hooks.example.com/${'a'.repeat(2048)}`],
    ['user info', 'https://user:pass@hooks.example.com/x'],
    ['a user name alone', 'https://user@hooks.example.com/x'],
    ['ftp:', 'ftp://hooks.example.com/x'],
    ['http: when http is not allowed', 'http://hooks.example.com/x'],
  ])('returns invalid-url for %s', (_case, input) => {
    expect(parseEndpointUrl(input, https)).toEqual({ ok: false, reason: 'invalid-url' });
  });

  it('accepts http: when http is allowed', () => {
    expect(parseEndpointUrl('http://hooks.example.com/x', { allowHttp: true })).toEqual({
      ok: true,
      url: 'http://hooks.example.com/x',
    });
  });

  it.each([
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://0x7f.1/x',
    'https://2130706433/x',
    'https://169.254.169.254/latest/meta-data',
  ])('returns destination-not-allowed for the literal refused host in %s', (input) => {
    expect(parseEndpointUrl(input, https)).toEqual({
      ok: false,
      reason: 'destination-not-allowed',
    });
  });

  it('accepts https://hooks.example.com/x?y=1 and returns it normalised', () => {
    expect(parseEndpointUrl('  HTTPS://Hooks.Example.COM:443/x?y=1', https)).toEqual({
      ok: true,
      url: 'https://hooks.example.com/x?y=1',
    });
  });

  it('accepts a literal public address', () => {
    expect(parseEndpointUrl('https://1.1.1.1/hook', https)).toEqual({
      ok: true,
      url: 'https://1.1.1.1/hook',
    });
  });
});
