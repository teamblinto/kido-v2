import { describe, expect, it } from 'vitest';

import {
  checkpointDiffFileSchema,
  checkpointDiffResponseSchema,
  checkpointFileSchema,
  checkpointKindSchema,
  checkpointListQuerySchema,
  checkpointListResponseSchema,
  checkpointSchema,
} from './checkpoint';

const SHA = 'a'.repeat(40);
const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

const baseline = {
  actorId: null,
  createdAt: '2026-09-17T10:00:00.000Z',
  files: [],
  gitSha: SHA,
  id: UUID,
  kind: 'baseline',
  label: 'Baseline: vite-react forge-tpl-1',
  mirroredAt: null,
  parentId: null,
  revertsId: null,
  runId: null,
  turn: null,
};

describe('checkpointKindSchema', () => {
  it('accepts baseline, turn, revert, pull and edit only', () => {
    expect(checkpointKindSchema.safeParse('baseline').success).toBe(true);
    expect(checkpointKindSchema.safeParse('turn').success).toBe(true);
    expect(checkpointKindSchema.safeParse('revert').success).toBe(true);
    expect(checkpointKindSchema.safeParse('pull').success).toBe(true);
    expect(checkpointKindSchema.safeParse('edit').success).toBe(true);
    expect(checkpointKindSchema.safeParse('other').success).toBe(false);
  });
});

describe('checkpointFileSchema', () => {
  it('accepts a well-formed row', () => {
    expect(
      checkpointFileSchema.safeParse({ bytes: 12, path: 'src/App.tsx', status: 'M' }).success,
    ).toBe(true);
  });

  it('refuses an undeclared field and an unknown status', () => {
    expect(
      checkpointFileSchema.safeParse({ bytes: 1, path: 'a', status: 'M', extra: 1 }).success,
    ).toBe(false);
    expect(checkpointFileSchema.safeParse({ bytes: 1, path: 'a', status: 'X' }).success).toBe(
      false,
    );
    expect(checkpointFileSchema.safeParse({ bytes: -1, path: 'a', status: 'M' }).success).toBe(
      false,
    );
  });
});

describe('checkpointSchema', () => {
  it('accepts a baseline row', () => {
    expect(checkpointSchema.safeParse(baseline)).toEqual({ data: baseline, success: true });
  });

  it('accepts a turn row', () => {
    const turn = { ...baseline, kind: 'turn', parentId: UUID, runId: UUID, turn: 3 };

    expect(checkpointSchema.safeParse(turn).success).toBe(true);
  });

  it('accepts a revert row', () => {
    const revert = { ...baseline, actorId: UUID, kind: 'revert', parentId: UUID, revertsId: UUID };

    expect(checkpointSchema.safeParse(revert).success).toBe(true);
  });

  it('accepts an edit row — an actor, a parent, and no run (spec 024)', () => {
    const edit = {
      ...baseline,
      actorId: UUID,
      kind: 'edit',
      label: 'Edit src/App.tsx',
      parentId: UUID,
    };

    expect(checkpointSchema.safeParse(edit).success).toBe(true);
  });

  it('refuses an undeclared field', () => {
    expect(checkpointSchema.safeParse({ ...baseline, extra: 1 }).success).toBe(false);
  });

  it('enforces the 40-hex sha regex', () => {
    expect(checkpointSchema.safeParse({ ...baseline, gitSha: 'not-a-sha' }).success).toBe(false);
    expect(checkpointSchema.safeParse({ ...baseline, gitSha: SHA.toUpperCase() }).success).toBe(
      false,
    );
    expect(checkpointSchema.safeParse({ ...baseline, gitSha: SHA.slice(0, 39) }).success).toBe(
      false,
    );
  });

  it('refuses an empty or over-long label', () => {
    expect(checkpointSchema.safeParse({ ...baseline, label: '' }).success).toBe(false);
    expect(checkpointSchema.safeParse({ ...baseline, label: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('checkpointListQuerySchema / checkpointListResponseSchema', () => {
  it('accepts an empty query and defaults the limit', () => {
    const result = checkpointListQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(25);
  });

  it('refuses an undeclared query field', () => {
    expect(checkpointListQuerySchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('accepts a page of checkpoints with a nullable cursor', () => {
    expect(
      checkpointListResponseSchema.safeParse({ items: [baseline], nextCursor: null }).success,
    ).toBe(true);
  });

  it('refuses an undeclared response field', () => {
    expect(
      checkpointListResponseSchema.safeParse({ extra: 1, items: [], nextCursor: null }).success,
    ).toBe(false);
  });
});

describe('checkpointDiffFileSchema (discriminated union)', () => {
  it('accepts the text branch with a patch and truncated flag', () => {
    expect(
      checkpointDiffFileSchema.safeParse({
        binary: false,
        path: 'src/App.tsx',
        patch: '@@ -1 +1 @@',
        status: 'M',
        truncated: false,
      }).success,
    ).toBe(true);
  });

  it('accepts the binary branch with bytes and no patch', () => {
    expect(
      checkpointDiffFileSchema.safeParse({
        binary: true,
        bytes: 2048,
        path: 'assets/logo.png',
        status: 'A',
      }).success,
    ).toBe(true);
  });

  it('refuses a binary row carrying a patch and a text row carrying bytes', () => {
    expect(
      checkpointDiffFileSchema.safeParse({
        binary: true,
        bytes: 1,
        patch: 'x',
        path: 'a',
        status: 'A',
      }).success,
    ).toBe(false);
    expect(
      checkpointDiffFileSchema.safeParse({
        binary: false,
        bytes: 1,
        path: 'a',
        patch: 'x',
        status: 'M',
        truncated: false,
      }).success,
    ).toBe(false);
  });
});

describe('checkpointDiffResponseSchema', () => {
  it('accepts a mixed set of diff files', () => {
    expect(
      checkpointDiffResponseSchema.safeParse({
        checkpointId: UUID,
        files: [
          { binary: false, path: 'a', patch: '@@', status: 'M', truncated: false },
          { binary: true, bytes: 5, path: 'b', status: 'A' },
        ],
        parentId: null,
      }).success,
    ).toBe(true);
  });

  it('refuses an undeclared field', () => {
    expect(
      checkpointDiffResponseSchema.safeParse({
        checkpointId: UUID,
        extra: 1,
        files: [],
        parentId: null,
      }).success,
    ).toBe(false);
  });
});
