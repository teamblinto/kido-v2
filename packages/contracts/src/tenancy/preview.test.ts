import { describe, expect, it } from 'vitest';

import {
  PREVIEW_STAGES,
  authorizePreviewResponseSchema,
  PREVIEW_LABEL_ROTATED,
  previewResponseSchema,
  previewVisibilitySchema,
  rotatePreviewResponseSchema,
  sandboxCallbackRequestSchema,
  setPreviewVisibilityRequestSchema,
} from './preview';

describe('authorizePreviewResponseSchema', () => {
  it('accepts the return url and nothing else', () => {
    const url = 'https://abc123-4173.preview.example.com:3200/?code=abc.def';
    expect(authorizePreviewResponseSchema.safeParse({ url }).success).toBe(true);
    expect(authorizePreviewResponseSchema.safeParse({ url: 'not a url' }).success).toBe(false);
    expect(authorizePreviewResponseSchema.safeParse({ code: 'abc', url }).success).toBe(false);
  });
});

describe('previewVisibilitySchema', () => {
  it('accepts private, org, public only', () => {
    expect(previewVisibilitySchema.safeParse('private').success).toBe(true);
    expect(previewVisibilitySchema.safeParse('org').success).toBe(true);
    expect(previewVisibilitySchema.safeParse('public').success).toBe(true);
    expect(previewVisibilitySchema.safeParse('unlisted').success).toBe(false);
  });
});

describe('previewResponseSchema', () => {
  const base = {
    port: 4173,
    stage: 'ready',
    url: 'https://abc123-4173.preview.example.com',
    visibility: 'private',
  };

  it('accepts a well-formed response', () => {
    expect(previewResponseSchema.safeParse(base).success).toBe(true);
  });

  it('accepts every start-up stage and refuses an unknown one or none', () => {
    for (const stage of PREVIEW_STAGES) {
      expect(previewResponseSchema.safeParse({ ...base, stage }).success).toBe(true);
    }
    expect(previewResponseSchema.safeParse({ ...base, stage: 'booting' }).success).toBe(false);
    expect(previewResponseSchema.safeParse({ ...base, stage: undefined }).success).toBe(false);
  });

  it('accepts a null port with an empty url, for a template with no devPort', () => {
    expect(previewResponseSchema.safeParse({ ...base, port: null, url: '' }).success).toBe(true);
  });

  it('refuses a non-integer port', () => {
    expect(previewResponseSchema.safeParse({ ...base, port: 4173.5 }).success).toBe(false);
  });

  it('refuses an undeclared field', () => {
    expect(previewResponseSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it('carries no label', () => {
    expect(previewResponseSchema.safeParse({ ...base, label: 'abc123' }).success).toBe(false);
  });
});

describe('setPreviewVisibilityRequestSchema', () => {
  it('accepts a bare visibility', () => {
    expect(setPreviewVisibilityRequestSchema.safeParse({ visibility: 'org' }).success).toBe(true);
  });

  it('refuses an undeclared field and an unknown visibility', () => {
    expect(
      setPreviewVisibilityRequestSchema.safeParse({ extra: 1, visibility: 'org' }).success,
    ).toBe(false);
    expect(setPreviewVisibilityRequestSchema.safeParse({ visibility: 'hidden' }).success).toBe(
      false,
    );
  });
});

describe('rotatePreviewResponseSchema', () => {
  const base = {
    port: 4173,
    status: PREVIEW_LABEL_ROTATED,
    url: 'https://def456-4173.preview.example.com',
  };

  it('accepts a well-formed response', () => {
    expect(rotatePreviewResponseSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a null port', () => {
    expect(rotatePreviewResponseSchema.safeParse({ ...base, port: null }).success).toBe(true);
  });

  it('refuses any status other than the literal', () => {
    expect(rotatePreviewResponseSchema.safeParse({ ...base, status: 'rotated' }).success).toBe(
      false,
    );
  });

  it('refuses an undeclared field', () => {
    expect(rotatePreviewResponseSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe('sandboxCallbackRequestSchema (discriminated union)', () => {
  it('accepts a preview.status callback', () => {
    expect(
      sandboxCallbackRequestSchema.safeParse({
        action: 'preview.status',
        port: 4173,
        state: 'listening',
      }).success,
    ).toBe(true);
  });

  it('refuses a port outside 1024-65535', () => {
    expect(
      sandboxCallbackRequestSchema.safeParse({
        action: 'preview.status',
        port: 1023,
        state: 'starting',
      }).success,
    ).toBe(false);
    expect(
      sandboxCallbackRequestSchema.safeParse({
        action: 'preview.status',
        port: 65_536,
        state: 'starting',
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown state', () => {
    expect(
      sandboxCallbackRequestSchema.safeParse({
        action: 'preview.status',
        port: 4173,
        state: 'stopped',
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown action', () => {
    expect(
      sandboxCallbackRequestSchema.safeParse({
        action: 'preview.pinged',
        port: 4173,
        state: 'listening',
      }).success,
    ).toBe(false);
  });

  it('refuses an undeclared field', () => {
    expect(
      sandboxCallbackRequestSchema.safeParse({
        action: 'preview.status',
        extra: 1,
        port: 4173,
        state: 'listening',
      }).success,
    ).toBe(false);
  });
});
