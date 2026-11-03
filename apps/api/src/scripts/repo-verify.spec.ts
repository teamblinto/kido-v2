import { describe, expect, it, vi } from 'vitest';

import { type Exec, exitCode, formatRow, parseArgs, verifyBundle } from './repo-verify';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** The pure halves of `repo:verify` (spec 016 contract § 8, research R12). */
describe('repo-verify parseArgs', () => {
  it('org project', () => {
    expect(parseArgs([ORG, PROJECT])).toEqual({ mirrorNow: false, orgId: ORG, projectId: PROJECT });
  });

  it('org project --mirror-now', () => {
    expect(parseArgs([ORG, PROJECT, '--mirror-now'])).toEqual({
      mirrorNow: true,
      orgId: ORG,
      projectId: PROJECT,
    });
  });

  it.each([[[]], [[ORG]], [[ORG, PROJECT, '--now']], [[ORG, PROJECT, '--mirror-now', 'x']]])(
    '%j is refused with the usage',
    (argv) => {
      expect(() => parseArgs(argv)).toThrow('usage');
    },
  );
});

describe('repo-verify formatRow', () => {
  it('prints the two heads, current and the bundle state', () => {
    expect(formatRow({ bundle: 'verified', head: SHA, mirror: SHA })).toBe(
      `head checkpoint: ${SHA}\nmirror head: ${SHA}\ncurrent: yes\nbundle: verified`,
    );
  });

  it('prints `-` for an absent head and `no` when the shas differ', () => {
    expect(formatRow({ bundle: 'missing', head: null, mirror: null })).toBe(
      'head checkpoint: -\nmirror head: -\ncurrent: no\nbundle: missing',
    );
    expect(formatRow({ bundle: 'corrupt', head: SHA, mirror: OTHER })).toBe(
      `head checkpoint: ${SHA}\nmirror head: ${OTHER}\ncurrent: no\nbundle: corrupt`,
    );
  });
});

describe('repo-verify exitCode', () => {
  it('is 0 only when current and verified', () => {
    expect(exitCode({ bundle: 'verified', head: SHA, mirror: SHA })).toBe(0);
    expect(exitCode({ bundle: 'verified', head: SHA, mirror: OTHER })).toBe(1);
    expect(exitCode({ bundle: 'corrupt', head: SHA, mirror: SHA })).toBe(1);
    expect(exitCode({ bundle: 'missing', head: null, mirror: null })).toBe(1);
  });
});

describe('repo-verify verifyBundle', () => {
  const exec = (verifyOk: boolean, lsRemote: string): Exec =>
    vi.fn((_file: string, args: readonly string[]) =>
      Promise.resolve(
        args[0] === 'bundle'
          ? { ok: verifyOk, stdout: '' }
          : { ok: true, stdout: `${lsRemote}\tHEAD\n` },
      ),
    );

  it('is verified when `git bundle verify` passes and HEAD is the labelled sha', async () => {
    const run = exec(true, SHA);
    await expect(verifyBundle(Buffer.from('bundle'), SHA, run)).resolves.toBe('verified');
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.mocked(run).mock.calls[0]?.[1]?.slice(0, 2)).toEqual(['bundle', 'verify']);
    expect(vi.mocked(run).mock.calls[1]?.[1]?.[0]).toBe('ls-remote');
  });

  it('is corrupt when `git bundle verify` fails', async () => {
    await expect(verifyBundle(Buffer.from('bundle'), SHA, exec(false, SHA))).resolves.toBe(
      'corrupt',
    );
  });

  it('is corrupt when the bundle HEAD is not the labelled sha', async () => {
    await expect(verifyBundle(Buffer.from('bundle'), SHA, exec(true, OTHER))).resolves.toBe(
      'corrupt',
    );
  });
});
