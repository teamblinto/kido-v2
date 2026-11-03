import type { ModelCatalogueResponse, SubscriptionList } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { modelCatalogue } from '@/test/server';
import { defaultChoice, noWayToPay, rankByQuery, resolveChoice, runBody } from './model-choice';

function claude(overrides: Partial<SubscriptionList['claude']> = {}): SubscriptionList {
  return {
    claude: {
      message: null,
      models: null,
      plan: null,
      provider: 'claude',
      signIn: null,
      state: 'disconnected',
      updatedAt: '2026-11-03T10:00:00.000Z',
      usage: null,
      ...overrides,
    },
  };
}

const connected = claude({
  models: [
    { description: null, id: 'opus', label: 'Opus' },
    { description: null, id: 'sonnet', label: 'Sonnet' },
  ],
  state: 'connected',
});
const empty: ModelCatalogueResponse = { default: null, models: [] };

describe('model choice (spec 043)', () => {
  it('ranks an exact match over a prefix over a word boundary over a substring', () => {
    const ranked = rankByQuery(
      ['Personal', 'claude-sonnet-5', 'Sonnet 4', 'son', 'Opus'],
      'son',
      (name) => [name],
    );

    expect(ranked).toEqual(['son', 'Sonnet 4', 'claude-sonnet-5', 'Personal']);
  });

  it('keeps every item, in order, for an empty query', () => {
    expect(rankByQuery(['b', 'a'], '  ', (name) => [name])).toEqual(['b', 'a']);
  });

  it('sends the subscription and its model for a subscription choice, the model alone for a key', () => {
    expect(runBody('go', { model: 'opus', source: 'subscription' })).toEqual({
      model: 'opus',
      prompt: 'go',
      subscription: { provider: 'claude' },
    });
    expect(runBody('go', { source: 'subscription' })).toEqual({
      prompt: 'go',
      subscription: { provider: 'claude' },
    });
    expect(runBody('go', { model: 'claude-opus-5', source: 'catalogue' })).toEqual({
      model: 'claude-opus-5',
      prompt: 'go',
    });
    expect(runBody('go', undefined)).toEqual({ prompt: 'go' });
  });

  it("defaults to the person's own plan, then to the catalogue's default", () => {
    expect(defaultChoice({ catalogue: modelCatalogue, subscriptions: connected })).toEqual({
      model: 'opus',
      source: 'subscription',
    });
    expect(defaultChoice({ catalogue: modelCatalogue, subscriptions: claude() })).toEqual({
      model: 'claude-sonnet-5',
      source: 'catalogue',
    });
    expect(defaultChoice({ catalogue: empty, subscriptions: claude() })).toBeUndefined();
  });

  it('keeps a remembered choice while it is offered or unknown, and drops it once it is not', () => {
    const opus = { model: 'opus', source: 'subscription' } as const;

    expect(resolveChoice(opus, { catalogue: undefined, subscriptions: undefined })).toEqual(opus);
    expect(resolveChoice(opus, { catalogue: modelCatalogue, subscriptions: connected })).toEqual(
      opus,
    );
    expect(resolveChoice(opus, { catalogue: modelCatalogue, subscriptions: claude() })).toEqual({
      model: 'claude-sonnet-5',
      source: 'catalogue',
    });
  });

  it('finds no way to pay only when both reads answered and neither can', () => {
    expect(noWayToPay({ catalogue: empty, subscriptions: claude() })).toBe(true);
    expect(noWayToPay({ catalogue: empty, subscriptions: undefined })).toBe(false);
    expect(noWayToPay({ catalogue: undefined, subscriptions: claude() })).toBe(false);
    expect(noWayToPay({ catalogue: empty, subscriptions: connected })).toBe(false);
    expect(noWayToPay({ catalogue: modelCatalogue, subscriptions: claude() })).toBe(false);
  });
});
