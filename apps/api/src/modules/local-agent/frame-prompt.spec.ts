import { describe, expect, it } from 'vitest';

import { framePrompt } from './local-agent.executor';

describe('framePrompt', () => {
  it('sends the prompt as it is when nothing is connected', () => {
    expect(framePrompt('', 'build a todo app')).toBe('build a todo app');
  });

  it('leads with the connected-services note and stays within the command limit', () => {
    const framed = framePrompt('Connected services: Supabase', 'build a todo app');

    expect(framed.startsWith('Connected services: Supabase')).toBe(true);
    expect(framed.endsWith("The user's request:\nbuild a todo app")).toBe(true);
    expect(framePrompt('note', 'x'.repeat(40_000))).toHaveLength(32_000);
  });
});
