import { describe, expect, it } from 'vitest';

import { hasShape, KEY_SHAPES } from './key-shapes';

const ANTHROPIC = `sk-ant-api03-${'a'.repeat(40)}`;
const OPENAI = `sk-proj-${'b'.repeat(40)}`;

describe('hasShape', () => {
  it('covers every provider', () => {
    expect(Object.keys(KEY_SHAPES).sort()).toEqual(['anthropic', 'openai']);
  });

  it("accepts each provider's real-looking key", () => {
    expect(hasShape('anthropic', ANTHROPIC)).toBe(true);
    expect(hasShape('openai', OPENAI)).toBe(true);
  });

  it.each(['not-a-key', 'https://api.openai.com/v1/models', `ghp_${'c'.repeat(36)}`])(
    'refuses %s for both providers',
    (key) => {
      expect(hasShape('anthropic', key)).toBe(false);
      expect(hasShape('openai', key)).toBe(false);
    },
  );

  it('refuses an OpenAI key under anthropic', () => {
    expect(hasShape('anthropic', OPENAI)).toBe(false);
  });

  /**
   * Research R10: `sk-ant-` is an `sk-` prefix, so the shape cannot tell an Anthropic key from an
   * OpenAI one. That case is closed by the verify call — OpenAI answers 401 and the service refuses
   * `key-rejected`. Documented here so nobody "fixes" the regex into a negative lookahead and then
   * wonders why the spec's "wrong provider" edge still needs the network.
   */
  it('lets an Anthropic key pass the openai shape (the R10 gap the verify call closes)', () => {
    expect(hasShape('openai', ANTHROPIC)).toBe(true);
  });
});
