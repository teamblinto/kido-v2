import { describe, expect, it } from 'vitest';

import {
  IMPORT_OUTCOMES,
  inspectImportRequestSchema,
  inspectImportResponseSchema,
  outcomeFor,
  startImportRequestSchema,
} from './import';

const SHA = 'a'.repeat(40);

const response = {
  branch: 'main',
  candidates: [{ evidence: ['next.config.ts', 'dependency: next'], template: 'nextjs' }],
  empty: false,
  headSha: SHA,
  outcome: 'proposed',
  repo: { id: 42, name: 'web', owner: 'acme' },
  sizeKib: 1024,
};

const start = { branch: 'main', name: 'Web', repoId: 42, template: 'nextjs' };

describe('inspectImportRequestSchema', () => {
  it('accepts a repository with and without an explicit branch', () => {
    expect(inspectImportRequestSchema.safeParse({ repoId: 42 }).success).toBe(true);
    expect(inspectImportRequestSchema.safeParse({ branch: 'dev', repoId: 42 }).success).toBe(true);
  });

  it('refuses an undeclared key and a repository id that is not one', () => {
    expect(inspectImportRequestSchema.safeParse({ extra: 1, repoId: 42 }).success).toBe(false);
    expect(inspectImportRequestSchema.safeParse({ repoId: 0 }).success).toBe(false);
    expect(inspectImportRequestSchema.safeParse({ repoId: 42, branch: '' }).success).toBe(false);
  });
});

describe('inspectImportResponseSchema', () => {
  it('accepts the three outcomes when they agree with the candidates', () => {
    expect(inspectImportResponseSchema.safeParse(response).success).toBe(true);
    expect(
      inspectImportResponseSchema.safeParse({
        ...response,
        candidates: [...response.candidates, { evidence: ['pyproject.toml'], template: 'python' }],
        outcome: 'ambiguous',
      }).success,
    ).toBe(true);
    expect(
      inspectImportResponseSchema.safeParse({
        ...response,
        candidates: [],
        outcome: 'unrecognised',
      }).success,
    ).toBe(true);
  });

  it('accepts an empty repository with no head', () => {
    expect(
      inspectImportResponseSchema.safeParse({
        ...response,
        candidates: [],
        empty: true,
        headSha: null,
        outcome: 'unrecognised',
        sizeKib: 0,
      }).success,
    ).toBe(true);
  });

  it('refuses an outcome that disagrees with the candidates', () => {
    // The whole point of deriving `outcome` server-side is that the client can trust it. A body
    // claiming a proposal it did not make would otherwise render as one.
    expect(
      inspectImportResponseSchema.safeParse({ ...response, outcome: 'unrecognised' }).success,
    ).toBe(false);
    expect(
      inspectImportResponseSchema.safeParse({ ...response, outcome: 'ambiguous' }).success,
    ).toBe(false);
    expect(
      inspectImportResponseSchema.safeParse({ ...response, candidates: [], outcome: 'proposed' })
        .success,
    ).toBe(false);
  });

  it('refuses an undeclared key, a candidate without evidence and a short head sha', () => {
    expect(inspectImportResponseSchema.safeParse({ ...response, extra: 1 }).success).toBe(false);
    expect(
      inspectImportResponseSchema.safeParse({
        ...response,
        candidates: [{ evidence: [], template: 'nextjs' }],
      }).success,
    ).toBe(false);
    expect(inspectImportResponseSchema.safeParse({ ...response, headSha: 'abc' }).success).toBe(
      false,
    );
  });
});

describe('outcomeFor', () => {
  it('derives each outcome from the candidate count', () => {
    expect(IMPORT_OUTCOMES).toEqual(['proposed', 'ambiguous', 'unrecognised']);
    expect(outcomeFor(0)).toBe('unrecognised');
    expect(outcomeFor(1)).toBe('proposed');
    expect(outcomeFor(2)).toBe('ambiguous');
  });
});

describe('startImportRequestSchema', () => {
  it('accepts a fully specified import', () => {
    expect(startImportRequestSchema.safeParse(start)).toEqual({ data: start, success: true });
  });

  it('start import accepts a repository alone, and refuses an unknown template', () => {
    // Spec 047 supersedes FR-011 here: no template is a smart import (the run profile is detected
    // from the repository), not a default template — and no branch or name is the default branch
    // and a generated name. A template that is named must still be one of the four.
    expect(startImportRequestSchema.parse({ repoId: start.repoId })).toEqual({
      repoId: start.repoId,
    });
    expect(startImportRequestSchema.safeParse({ ...start, template: 'rails' }).success).toBe(false);
  });

  it('refuses an undeclared key and an empty name or branch', () => {
    expect(startImportRequestSchema.safeParse({ ...start, extra: 1 }).success).toBe(false);
    expect(startImportRequestSchema.safeParse({ ...start, name: '' }).success).toBe(false);
    expect(startImportRequestSchema.safeParse({ ...start, branch: '' }).success).toBe(false);
  });
});
