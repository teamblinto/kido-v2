import { describe, expect, it } from 'vitest';

import { assessPassword } from './password';

describe('assessPassword', () => {
  it('returns a neutral result for an empty password', () => {
    expect(assessPassword('')).toEqual({ isBreached: false, message: '', score: 0 });
  });

  it('scores a short password as weak and reports its length', () => {
    const result = assessPassword('sunflower1');

    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.message).toBe('Weak — 10 characters. Try three unrelated words instead.');
  });

  it('scores a long multi-word passphrase as strong', () => {
    const result = assessPassword('otter-lantern-basalt-97');

    expect(result.score).toBe(4);
    expect(result.message).toBe('Strong — not found in any known breach');
  });

  it('flags a known breached password regardless of its length', () => {
    const result = assessPassword('Password1234');

    expect(result.isBreached).toBe(true);
    expect(result.score).toBe(1);
    expect(result.message).toContain('Weak');
  });
});
