import { describe, expect, it } from 'vitest';

import {
  FILE_PATH_MAX_LENGTH,
  fileContentResponseSchema,
  fileEntrySchema,
  fileListResponseSchema,
  filePathQuerySchema,
  wakeResponseSchema,
  writeFileConflictReasonSchema,
  writeFileRequestSchema,
  writeFileResponseSchema,
} from './files';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

/** An `edit` row as the save answers with one (spec 024 data-model § 1). */
const editCheckpoint = {
  actorId: UUID,
  createdAt: '2026-09-22T10:00:00.000Z',
  files: [{ bytes: 12, path: 'src/app.tsx', status: 'M' }],
  gitSha: 'a'.repeat(40),
  id: UUID,
  kind: 'edit',
  label: 'Edit src/app.tsx',
  mirroredAt: null,
  parentId: UUID,
  revertsId: null,
  runId: null,
  turn: null,
};

describe('filePathQuerySchema', () => {
  it('accepts the root and a relative path', () => {
    expect(filePathQuerySchema.safeParse({ path: '' }).success).toBe(true);
    expect(filePathQuerySchema.safeParse({ path: 'src/app.tsx' }).success).toBe(true);
  });

  it('refuses an undeclared field', () => {
    expect(filePathQuerySchema.safeParse({ extra: 1, path: 'src' }).success).toBe(false);
  });

  it('refuses a path over 1024 characters', () => {
    expect(filePathQuerySchema.safeParse({ path: 'a'.repeat(1024) }).success).toBe(true);
    expect(filePathQuerySchema.safeParse({ path: 'a'.repeat(1025) }).success).toBe(false);
  });
});

describe('fileEntrySchema / fileListResponseSchema', () => {
  it('accepts every entry kind the port returns', () => {
    for (const kind of ['file', 'directory', 'link']) {
      expect(fileEntrySchema.safeParse({ kind, name: 'app.tsx', size: 0 }).success).toBe(true);
    }
  });

  it('refuses an unknown kind, an empty name and a negative size', () => {
    expect(fileEntrySchema.safeParse({ kind: 'socket', name: 'x', size: 1 }).success).toBe(false);
    expect(fileEntrySchema.safeParse({ kind: 'file', name: '', size: 1 }).success).toBe(false);
    expect(fileEntrySchema.safeParse({ kind: 'file', name: 'x', size: -1 }).success).toBe(false);
  });

  it('accepts a listing and refuses an undeclared field', () => {
    expect(
      fileListResponseSchema.safeParse({
        entries: [{ kind: 'directory', name: 'src', size: 0 }],
        path: '',
      }).success,
    ).toBe(true);
    expect(fileListResponseSchema.safeParse({ entries: [], extra: 1, path: '' }).success).toBe(
      false,
    );
  });
});

describe('fileContentResponseSchema', () => {
  it('accepts the renderable shape', () => {
    expect(
      fileContentResponseSchema.safeParse({
        baseCheckpointId: UUID,
        bytes: 5,
        content: 'hello',
        path: 'README.md',
        renderable: true,
      }).success,
    ).toBe(true);
  });

  it('refuses a renderable answer with no base, and one whose base is malformed', () => {
    expect(
      fileContentResponseSchema.safeParse({
        bytes: 5,
        content: 'hello',
        path: 'README.md',
        renderable: true,
      }).success,
    ).toBe(false);
    expect(
      fileContentResponseSchema.safeParse({
        baseCheckpointId: 'not-a-uuid',
        bytes: 5,
        content: 'hello',
        path: 'README.md',
        renderable: true,
      }).success,
    ).toBe(false);
  });

  it('leaves the unrenderable branch without a base — it cannot be saved', () => {
    expect(
      fileContentResponseSchema.safeParse({
        baseCheckpointId: UUID,
        bytes: 4_000_000,
        path: 'logo.png',
        reason: 'binary',
        renderable: false,
      }).success,
    ).toBe(false);
  });

  it('accepts both unrenderable shapes', () => {
    for (const reason of ['binary', 'too-large']) {
      expect(
        fileContentResponseSchema.safeParse({
          bytes: 4_000_000,
          path: 'logo.png',
          reason,
          renderable: false,
        }).success,
      ).toBe(true);
    }
  });

  it('refuses `content` on the unrenderable shape', () => {
    expect(
      fileContentResponseSchema.safeParse({
        bytes: 3,
        content: 'nul',
        path: 'logo.png',
        reason: 'binary',
        renderable: false,
      }).success,
    ).toBe(false);
  });

  it('refuses a missing `content` on the renderable shape and an unknown reason', () => {
    expect(
      fileContentResponseSchema.safeParse({
        baseCheckpointId: UUID,
        bytes: 5,
        path: 'README.md',
        renderable: true,
      }).success,
    ).toBe(false);
    expect(
      fileContentResponseSchema.safeParse({
        bytes: 5,
        path: 'logo.png',
        reason: 'forbidden',
        renderable: false,
      }).success,
    ).toBe(false);
  });
});

describe('wakeResponseSchema', () => {
  it('accepts a ready sandbox', () => {
    expect(wakeResponseSchema.safeParse({ because: null, ready: true }).success).toBe(true);
  });

  it('accepts every transition reason', () => {
    for (const because of ['creating', 'resuming', 'hibernating', 'releasing']) {
      expect(wakeResponseSchema.safeParse({ because, ready: false }).success).toBe(true);
    }
  });

  it('refuses an unknown reason, a missing `because` and an undeclared field', () => {
    expect(wakeResponseSchema.safeParse({ because: 'napping', ready: false }).success).toBe(false);
    expect(wakeResponseSchema.safeParse({ ready: true }).success).toBe(false);
    expect(wakeResponseSchema.safeParse({ because: null, extra: 1, ready: true }).success).toBe(
      false,
    );
  });
});

describe('writeFileRequestSchema', () => {
  it('accepts a save naming its path, its content and its base', () => {
    expect(
      writeFileRequestSchema.safeParse({
        baseCheckpointId: UUID,
        content: 'export const a = 1;\n',
        path: 'src/app.tsx',
      }).success,
    ).toBe(true);
  });

  it('accepts empty content — emptying a file is a save, not a deletion', () => {
    expect(
      writeFileRequestSchema.safeParse({ baseCheckpointId: UUID, content: '', path: 'a.txt' })
        .success,
    ).toBe(true);
  });

  it('refuses an undeclared key, before anything reaches a workspace', () => {
    expect(
      writeFileRequestSchema.safeParse({
        baseCheckpointId: UUID,
        content: 'x',
        force: true,
        path: 'a.txt',
      }).success,
    ).toBe(false);
  });

  it('refuses a malformed base, a missing base and a missing path', () => {
    expect(
      writeFileRequestSchema.safeParse({ baseCheckpointId: 'cp_a', content: 'x', path: 'a.txt' })
        .success,
    ).toBe(false);
    expect(writeFileRequestSchema.safeParse({ content: 'x', path: 'a.txt' }).success).toBe(false);
    expect(writeFileRequestSchema.safeParse({ baseCheckpointId: UUID, content: 'x' }).success).toBe(
      false,
    );
  });

  it('refuses an empty path and one over the shared bound', () => {
    expect(
      writeFileRequestSchema.safeParse({ baseCheckpointId: UUID, content: 'x', path: '' }).success,
    ).toBe(false);
    expect(
      writeFileRequestSchema.safeParse({
        baseCheckpointId: UUID,
        content: 'x',
        path: 'a'.repeat(FILE_PATH_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('writeFileResponseSchema', () => {
  it('discriminates on `saved`: the new checkpoint, or the head nothing was made from', () => {
    const saved = writeFileResponseSchema.safeParse({ checkpoint: editCheckpoint, saved: true });
    const unchanged = writeFileResponseSchema.safeParse({
      checkpoint: editCheckpoint,
      saved: false,
    });

    expect(saved.success).toBe(true);
    expect(unchanged.success).toBe(true);
    expect(saved.success && saved.data.saved).toBe(true);
    expect(unchanged.success && unchanged.data.saved).toBe(false);
  });

  it('refuses a missing discriminator, a non-boolean one and an undeclared key', () => {
    expect(writeFileResponseSchema.safeParse({ checkpoint: editCheckpoint }).success).toBe(false);
    expect(
      writeFileResponseSchema.safeParse({ checkpoint: editCheckpoint, saved: 'true' }).success,
    ).toBe(false);
    expect(
      writeFileResponseSchema.safeParse({ checkpoint: editCheckpoint, extra: 1, saved: true })
        .success,
    ).toBe(false);
  });

  it('refuses a body with no checkpoint — both branches carry one', () => {
    expect(writeFileResponseSchema.safeParse({ saved: false }).success).toBe(false);
  });
});

describe('writeFileConflictReasonSchema', () => {
  it('accepts the two refusals the save can make, and nothing else', () => {
    expect(writeFileConflictReasonSchema.safeParse('run-active').success).toBe(true);
    expect(writeFileConflictReasonSchema.safeParse('base-moved').success).toBe(true);
    expect(writeFileConflictReasonSchema.safeParse('locked').success).toBe(false);
  });
});
