import { describe, expect, it } from 'vitest';

import { cn } from './utils';

describe('cn', () => {
  it('keeps a named font size alongside a text colour', () => {
    expect(cn('text-heading-xl', 'text-foreground')).toBe('text-heading-xl text-foreground');
    expect(cn('text-label-md', 'text-primary-foreground')).toBe(
      'text-label-md text-primary-foreground',
    );
  });

  it('still resolves conflicts within the named font-size scale', () => {
    expect(cn('text-body-md', 'text-body-sm')).toBe('text-body-sm');
  });

  it('still resolves colour conflicts', () => {
    expect(cn('text-subdued', 'text-faint')).toBe('text-faint');
  });

  it('drops falsy values', () => {
    expect(cn('px-2', false, undefined, 'py-1')).toBe('px-2 py-1');
  });
});
