import { describe, expect, it } from 'vitest';

import {
  LINK_POSITIONS,
  REPO_LINK_STATES,
  putRepoLinkRequestSchema,
  repoLinkSchema,
} from './repo-link';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

const link = {
  autoSync: true,
  branch: 'main',
  connectionId: UUID,
  id: UUID,
  lastPushedCheckpointId: null,
  linkedAt: '2026-09-20T10:00:00.000Z',
  linkedBy: { id: UUID, name: 'Ada' },
  position: 'unknown',
  remoteHeadSha: null,
  repository: { fullName: 'acme/app', id: 7, name: 'app', owner: 'acme' },
  sideBranch: null,
  state: 'linked',
};

describe('repo-link enums', () => {
  it('match contracts § 2', () => {
    expect(REPO_LINK_STATES).toEqual(['linked', 'disconnected']);
    expect(LINK_POSITIONS).toEqual(['level', 'ahead', 'behind', 'diverged', 'unknown']);
  });
});

describe('repoLinkSchema', () => {
  it('accepts a link', () => {
    expect(repoLinkSchema.safeParse(link)).toEqual({ data: link, success: true });
  });

  it('accepts a disconnected link with no connection (R13)', () => {
    const disconnected = { ...link, connectionId: null, state: 'disconnected' };

    expect(repoLinkSchema.safeParse(disconnected)).toEqual({ data: disconnected, success: true });
  });

  it('refuses an undeclared field and an unknown state', () => {
    expect(repoLinkSchema.safeParse({ ...link, extra: 1 }).success).toBe(false);
    expect(repoLinkSchema.safeParse({ ...link, state: 'gone' }).success).toBe(false);
  });
});

describe('putRepoLinkRequestSchema', () => {
  it('accepts create and existing', () => {
    expect(
      putRepoLinkRequestSchema.safeParse({ create: { name: 'my-app.v2', private: true } }).success,
    ).toBe(true);
    expect(putRepoLinkRequestSchema.safeParse({ existing: { repoId: 7 } }).success).toBe(true);
    expect(
      putRepoLinkRequestSchema.safeParse({ existing: { branch: 'dev', repoId: 7 } }).success,
    ).toBe(true);
  });

  it('refuses both arms, neither arm, and an undeclared field', () => {
    expect(
      putRepoLinkRequestSchema.safeParse({
        create: { name: 'a', private: false },
        existing: { repoId: 7 },
      }).success,
    ).toBe(false);
    expect(putRepoLinkRequestSchema.safeParse({}).success).toBe(false);
    expect(
      putRepoLinkRequestSchema.safeParse({ create: { extra: 1, name: 'a', private: false } })
        .success,
    ).toBe(false);
  });

  it('enforces the repository name alphabet and length', () => {
    for (const name of ['', 'a b', 'a/b', 'x'.repeat(101)]) {
      expect(putRepoLinkRequestSchema.safeParse({ create: { name, private: false } }).success).toBe(
        false,
      );
    }
  });
});
