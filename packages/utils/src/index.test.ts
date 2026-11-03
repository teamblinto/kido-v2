import { describe, expect, it } from 'vitest';

import { isNonEmptyString, joinUrl } from './index';

describe('joinUrl', () => {
  it('joins URLs without duplicate separators', () => {
    expect(joinUrl('https://example.com/', '/api/health')).toBe('https://example.com/api/health');
  });

  it('supports relative same-origin paths', () => {
    expect(joinUrl('', 'api/health')).toBe('/api/health');
  });
});

describe('isNonEmptyString', () => {
  it('accepts only non-empty strings', () => {
    expect(isNonEmptyString('value')).toBe(true);
    expect(isNonEmptyString('  ')).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
  });
});
