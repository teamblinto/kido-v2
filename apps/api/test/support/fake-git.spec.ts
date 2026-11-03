import { describe, expect, it } from 'vitest';

import type { ExecuteHandler, WorkspaceEntry } from './fake-daytona';
import { fakeGit } from './fake-git';

import {
  EMPTY_TREE,
  gitAdd,
  gitBundle,
  gitCommit,
  gitDiff,
  gitDiffQuiet,
  gitDiffTree,
  gitInit,
  gitLsTree,
  gitReadTree,
  gitRevParse,
  gitStatus,
  parseLsTree,
  parseNameStatus,
  splitDiff,
} from '../../src/modules/checkpoints/git-commands';
import { gitLsFiles } from '../../src/modules/agent/context/git-commands';

const WORK_DIR = '/home/daytona';

function harness() {
  let handler: ExecuteHandler = () => ({ exitCode: 127, result: '' });
  const workspace = new Map<string, WorkspaceEntry>([[WORK_DIR, { kind: 'dir' }]]);
  const git = fakeGit({ onExecute: (next) => (handler = next), workDir: WORK_DIR, workspace });
  const run = (command: string) => {
    const outcome = handler({ command });
    if ('status' in outcome) throw new Error('unexpected status');
    return outcome;
  };
  const write = (path: string, content: string) =>
    workspace.set(`${WORK_DIR}/${path}`, { kind: 'file', content: Buffer.from(content) });
  const commit = (label: string): string => {
    expect(run(gitAdd()).exitCode).toBe(0);
    expect(run(gitCommit(label)).exitCode).toBe(0);
    return run(gitRevParse()).result.trim();
  };
  return { commit, git, run, workspace, write };
}

describe('fakeGit', () => {
  it('refuses everything before init, then answers rev-parse only once something is committed', () => {
    const { commit, git, run, write } = harness();
    expect(run(gitStatus()).exitCode).toBe(128);
    expect(run(gitInit()).exitCode).toBe(0);
    expect(run(gitRevParse()).exitCode).toBe(128);
    write('a.txt', 'one\n');
    expect(run(gitStatus()).result).toBe('?? a.txt\n');
    const sha = commit('Baseline');
    expect(sha).toBe(git.shaOf(new Map([['a.txt', Buffer.from('one\n')]]), null));
    expect(run(gitStatus()).result).toBe('');
    expect(run(gitCommit('Empty')).exitCode).toBe(1);
    expect(git.commands.slice(0, 2)).toEqual(['git status --porcelain', 'git init -q']);
  });

  it('diff-tree and diff read as the parsers expect, the empty tree as the baseline parent', () => {
    const { commit, run, workspace, write } = harness();
    run(gitInit());
    write('a.txt', 'one\n');
    write('bin', '\0\x01');
    const first = commit('First');
    expect(parseNameStatus(run(gitDiffTree(null, first)).result)).toEqual([
      { path: 'a.txt', status: 'A' },
      { path: 'bin', status: 'A' },
    ]);
    workspace.delete(`${WORK_DIR}/a.txt`);
    write('b.txt', 'one\n'); // an exact move: `-M` reports a rename
    write('bin', '\0\x02');
    const second = commit('Second');
    expect(parseNameStatus(run(gitDiffTree(first, second)).result)).toEqual([
      { path: 'b.txt', status: 'R' },
      { path: 'bin', status: 'M' },
    ]);
    expect(splitDiff(run(gitDiff(first, second)).result)).toEqual([
      {
        binary: false,
        path: 'b.txt',
        patch: expect.stringContaining('rename to b.txt') as string,
        status: 'R',
        truncated: false,
      },
      { binary: true, path: 'bin', status: 'M' },
    ]);
    expect(splitDiff(run(gitDiff(EMPTY_TREE, first)).result)[0]).toMatchObject({
      patch: expect.stringContaining('+one') as string,
      status: 'A',
    });
    expect(run(gitDiffQuiet(first, second)).exitCode).toBe(1);
    expect(run(gitDiffQuiet(first, first)).exitCode).toBe(0);
    expect(run(gitDiffTree(first, 'f'.repeat(40))).exitCode).toBe(128);
  });

  it('read-tree rewrites the working tree; the revert commit is a new sha over HEAD', () => {
    const { commit, git, run, workspace, write } = harness();
    run(gitInit());
    write('a.txt', 'one\n');
    const first = commit('First');
    write('a.txt', 'two\n');
    write('extra.txt', 'x');
    const second = commit('Second');
    expect(run(gitReadTree(first)).exitCode).toBe(0);
    expect(workspace.has(`${WORK_DIR}/extra.txt`)).toBe(false);
    expect(run(gitDiffQuiet(first, second)).exitCode).toBe(1);
    expect(run(gitCommit('Revert to First')).exitCode).toBe(0);
    const third = run(gitRevParse()).result.trim();
    expect(third).not.toBe(first);
    expect(git.commits.get(third)).toMatchObject({ parent: second });
    expect(run(gitDiffQuiet(first, third)).exitCode).toBe(0);
  });

  it('bundle create lands the deterministic buffer where download serves it; ls-tree gives sizes', () => {
    const { commit, git, run, workspace, write } = harness();
    run(gitInit());
    expect(run(gitBundle()).exitCode).toBe(128);
    write('a.txt', 'hello');
    const sha = commit('First');
    expect(run(gitBundle()).exitCode).toBe(0);
    const bundle = workspace.get(`${WORK_DIR}/.git/forge-mirror.bundle`);
    expect(bundle?.kind === 'file' && bundle.content.equals(git.bundleOf(sha))).toBe(true);
    expect(parseLsTree(run(gitLsTree(sha)).result)).toEqual(new Map([['a.txt', 5]]));
    expect(run(gitStatus()).result).toBe(''); // the bundle under .git/ is not a change
  });

  it('ls-files lists the worktree less .git/ and the ignored, one path per line', () => {
    const { commit, run, write } = harness();
    run(gitInit());
    write('.gitignore', 'node_modules/\n');
    write('src/b.ts', '');
    commit('First');
    write('a.ts', '');
    write('node_modules/x.js', '');
    expect(run(gitLsFiles()).result).toBe('.gitignore\na.ts\nsrc/b.ts\n');
  });

  it('hands a non-git command to the fallback', () => {
    const { run } = harness();
    expect(run('pnpm install').exitCode).toBe(127);
  });
});
