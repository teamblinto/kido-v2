import { describe, expect, it } from 'vitest';

import { DomainError } from '../../../common/errors/domain-error';
import { BreachedPasswordError } from './breached-password.port';

describe('BreachedPasswordError', () => {
  /**
   * The third of the three password rejections, and the reason each one has its own slug: "choose a
   * longer password" and "choose a different password" are different instructions, and a client
   * that only sees `validation-failed` cannot tell a user which one they need.
   */
  it('carries its own problem slug at the validation status', () => {
    const error = new BreachedPasswordError();

    expect(error).toBeInstanceOf(DomainError);
    expect(error.type).toBe('password-breached');
    expect(error.status).toBe(422);
  });

  /** The count is a property of the corpus, not of this account — and it is not ours to publish. */
  it('says nothing about which corpus or how many times', () => {
    expect(JSON.stringify(new BreachedPasswordError().extensions)).toBe('{}');
  });
});
