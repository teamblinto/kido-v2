import { describe, expect, it } from 'vitest';

import {
  MODEL_CATALOGUE,
  MODEL_IDS,
  catalogueModelSchema,
  isCatalogueModel,
  modelCatalogueResponseSchema,
  providerOf,
} from './models';

const model = {
  available: true,
  credentialMode: 'PLATFORM',
  description: 'd',
  id: 'x',
  name: 'X',
  provider: 'anthropic',
  shortName: 'X',
};

describe('catalogueModelSchema / modelCatalogueResponseSchema', () => {
  it('accepts a model and refuses an undeclared field', () => {
    expect(catalogueModelSchema.safeParse(model).success).toBe(true);
    expect(catalogueModelSchema.safeParse({ ...model, extra: 1 }).success).toBe(false);
  });

  it('refuses an unknown provider or credential mode', () => {
    expect(catalogueModelSchema.safeParse({ ...model, provider: 'google' }).success).toBe(false);
    expect(catalogueModelSchema.safeParse({ ...model, credentialMode: 'OWN' }).success).toBe(false);
  });

  it('requires at least one model', () => {
    expect(modelCatalogueResponseSchema.safeParse({ default: 'x', models: [] }).success).toBe(
      false,
    );
  });
});

describe('MODEL_CATALOGUE / MODEL_IDS / isCatalogueModel / providerOf', () => {
  it('lists five models with unique ids, each a catalogue model once stamped per organisation', () => {
    expect(MODEL_CATALOGUE).toHaveLength(5);
    expect(new Set(MODEL_CATALOGUE.map((entry) => entry.id)).size).toBe(5);

    for (const entry of MODEL_CATALOGUE) {
      expect(
        catalogueModelSchema.safeParse({ ...entry, available: true, credentialMode: 'BYOK' })
          .success,
      ).toBe(true);
    }
  });

  it('knows its own ids and nothing else', () => {
    expect(MODEL_IDS.size).toBe(5);
    expect(isCatalogueModel('claude-sonnet-5')).toBe(true);
    expect(isCatalogueModel('gpt-5.2')).toBe(true);
    expect(isCatalogueModel('gpt-4')).toBe(false);
  });

  it('names the provider of a model, and nothing for a stranger', () => {
    expect(providerOf('claude-sonnet-5')).toBe('anthropic');
    expect(providerOf('gpt-5-mini')).toBe('openai');
    expect(providerOf('gpt-4')).toBeUndefined();
  });
});

describe('catalogueModelSchema — spec 032 BYOS fields', () => {
  it('accepts BYOS with a limit and an alternative, and a subscription needing reauth', () => {
    expect(
      catalogueModelSchema.safeParse({
        ...model,
        alternativeMode: 'BYOK',
        credentialMode: 'BYOS',
        limitedUntil: '2026-09-24T12:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      catalogueModelSchema.safeParse({
        ...model,
        available: false,
        credentialMode: 'BYOS',
        unavailableReason: 'subscription-needs-reauth',
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown unavailable reason, a BYOS alternative and a non-ISO limit', () => {
    expect(catalogueModelSchema.safeParse({ ...model, unavailableReason: 'x' }).success).toBe(
      false,
    );
    expect(catalogueModelSchema.safeParse({ ...model, alternativeMode: 'BYOS' }).success).toBe(
      false,
    );
    expect(catalogueModelSchema.safeParse({ ...model, limitedUntil: 'soon' }).success).toBe(false);
  });
});
