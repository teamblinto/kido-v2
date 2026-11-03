import { createHash } from 'node:crypto';

import type { ExecuteHandler, ExecuteRequest, FakeDaytona } from './fake-daytona';

import { EMPTY_TREE } from '../../src/modules/checkpoints/git-commands';

/**
 * The git of spec 016 in memory, scripted into `fake-daytona`'s `process/execute` for exactly
 * the commands `git-commands.ts` emits. The working tree is the fake's `workspace` under its
 * work dir (`.git/` excluded), so an upload dirties `status` and `read-tree` rewrites real
 * entries; `bundle create` writes `.git/forge-mirror.bundle` there so `download` serves it.
 * Shas are deterministic — sha1 of the parent and the sorted tree — so a spec can name them.
 */
export type Tree = Map<string, Buffer>;

export interface FakeCommit {
  readonly label: string;
  readonly parent: string | null;
  readonly tree: Tree;
}

export interface FakeGit {
  /** Every commit by sha — read a tree back, or count them. */
  readonly commits: Map<string, FakeCommit>;
  /** Every git command the fake answered, in order — for asserting the sequence. */
  readonly commands: string[];
  /** The current HEAD, `null` before the first commit. */
  head(): string | null;
  /** The sha `commit` will mint for this tree over this parent — to assert on before it exists. */
  shaOf(tree: Tree, parent: string | null): string;
  /** The bytes `download` serves for the bundle after `bundle create` at this head. */
  bundleOf(head: string): Buffer;
}

const BUNDLE = '.git/forge-mirror.bundle';

interface Outcome {
  exitCode: number;
  result: string;
}

const ok = (result = ''): Outcome => ({ exitCode: 0, result });
const fatal = (message: string): Outcome => ({ exitCode: 128, result: `fatal: ${message}\n` });

const sha1 = (input: Buffer | string): string => createHash('sha1').update(input).digest('hex');

const sorted = (tree: Tree): [string, Buffer][] =>
  [...tree.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const sameTree = (a: Tree, b: Tree): boolean =>
  a.size === b.size && [...a].every(([path, body]) => b.get(path)?.equals(body) === true);

const isBinary = (body: Buffer): boolean => body.subarray(0, 8000).includes(0);

interface Row {
  readonly old?: string;
  readonly path: string;
  readonly status: string;
}

/** Every `--name-status` row between two trees, `-M` renames included (an exact content move). */
const nameStatus = (a: Tree, b: Tree): Row[] => {
  const rows: Row[] = [];
  const deleted = new Map<string, string>(); // content sha → old path
  for (const [path, body] of sorted(a)) if (!b.has(path)) deleted.set(sha1(body), path);
  for (const [path, body] of sorted(b)) {
    const before = a.get(path);
    if (before === undefined) {
      const old = deleted.get(sha1(body));
      if (old === undefined) rows.push({ path, status: 'A' });
      else {
        deleted.delete(sha1(body));
        rows.push({ old, path, status: 'R100' });
      }
    } else if (!before.equals(body)) rows.push({ path, status: 'M' });
  }
  for (const old of deleted.values()) rows.push({ path: old, status: 'D' });
  return rows;
};

/** `git diff a b` as `splitDiff` reads it: one whole-file hunk per text change, a marker per binary. */
const unifiedDiff = (a: Tree, b: Tree): string =>
  nameStatus(a, b)
    .map((row) => {
      const before = a.get(row.old ?? row.path) ?? Buffer.alloc(0);
      const after = b.get(row.path) ?? Buffer.alloc(0);
      const lines = [`diff --git a/${row.old ?? row.path} b/${row.path}`];
      if (row.status === 'A') lines.push('new file mode 100644');
      else if (row.status === 'D') lines.push('deleted file mode 100644');
      else if (row.old !== undefined) {
        lines.push('similarity index 100%', `rename from ${row.old}`, `rename to ${row.path}`);
        return `${lines.join('\n')}\n`;
      }
      if (isBinary(before) || isBinary(after)) {
        lines.push(`Binary files a/${row.path} and b/${row.path} differ`);
        return `${lines.join('\n')}\n`;
      }
      const minus = before.length === 0 ? [] : before.toString('utf8').split('\n');
      const plus = after.length === 0 ? [] : after.toString('utf8').split('\n');
      lines.push(
        `--- ${row.status === 'A' ? '/dev/null' : `a/${row.path}`}`,
        `+++ ${row.status === 'D' ? '/dev/null' : `b/${row.path}`}`,
        `@@ -1,${minus.length} +1,${plus.length} @@`,
        ...minus.map((line) => `-${line}`),
        ...plus.map((line) => `+${line}`),
      );
      return `${lines.join('\n')}\n`;
    })
    .join('');

/**
 * Scripts `daytona.onExecute` with the git surface; any other command goes to `fallback`
 * (the default: exit 127). Call once per fake; the returned handle reads the repository.
 */
export function fakeGit(
  daytona: Pick<FakeDaytona, 'onExecute' | 'workDir' | 'workspace'>,
  fallback?: ExecuteHandler,
): FakeGit {
  const root = daytona.workDir;
  const commits = new Map<string, FakeCommit>();
  const commands: string[] = [];
  let initialised = false;
  let head: string | null = null;
  let fetchHead: string | null = null;
  let index: Tree = new Map();

  const shaOf = (tree: Tree, parent: string | null): string =>
    sha1(
      `${parent ?? ''}\n${sorted(tree)
        .map(([path, body]) => `${path}\0${sha1(body)}\n`)
        .join('')}`,
    );
  const bundleOf = (at: string): Buffer =>
    Buffer.from(`# v2 git bundle\n${at} refs/heads/master\n\n`);

  const treeOf = (sha: string): Tree | undefined =>
    sha === EMPTY_TREE ? new Map<string, Buffer>() : commits.get(sha)?.tree;
  const headTree = (): Tree =>
    head === null ? new Map<string, Buffer>() : commits.get(head)!.tree;

  /** The working tree: every file under the work dir but `.git/`, by path relative to it. */
  const worktree = (): Tree => {
    const tree: Tree = new Map();
    for (const [key, entry] of daytona.workspace) {
      if (!key.startsWith(`${root}/`) || entry.kind !== 'file') continue;
      const path = key.slice(root.length + 1);
      if (!path.startsWith('.git/')) tree.set(path, entry.content);
    }
    return tree;
  };
  /**
   * The worktree's `.gitignore`, enough for the default set: a pattern matches a path whose
   * base name (or, with a trailing `/`, any directory segment) matches its glob, `*` included.
   */
  const ignored = (tree: Tree, path: string): boolean => {
    const rules = tree.get('.gitignore')?.toString('utf8').split('\n') ?? [];
    const segments = path.split('/');
    return rules.some((rule) => {
      const pattern = rule.trim();
      if (pattern === '' || pattern.startsWith('#')) return false;
      const dirOnly = pattern.endsWith('/');
      const glob = new RegExp(
        `^${pattern
          .replace(/\/$/, '')
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')}$`,
      );
      return (dirOnly ? segments.slice(0, -1) : segments).some((segment) => glob.test(segment));
    });
  };
  /** The worktree less what its `.gitignore` excludes — what `add -A` and `status` see. */
  const tracked = (): Tree => {
    const tree = worktree();
    return new Map([...tree].filter(([path]) => !ignored(tree, path)));
  };
  const writeWorktree = (tree: Tree): void => {
    for (const path of worktree().keys()) daytona.workspace.delete(`${root}/${path}`);
    for (const [path, content] of tree) {
      daytona.workspace.set(`${root}/${path}`, { kind: 'file', content });
    }
  };

  /** Two revisions' trees, or the one that is not an object. */
  const two = (args: string): [Tree, Tree] | Outcome => {
    const [a, b] = args.split(' ') as [string, string];
    const left = treeOf(a);
    const right = treeOf(b);
    if (left === undefined) return fatal(`bad object ${a}`);
    if (right === undefined) return fatal(`bad object ${b}`);
    return [left, right];
  };

  const git = (command: string): Outcome | undefined => {
    if (command === 'git init -q') {
      initialised = true;
      daytona.workspace.set(`${root}/.git`, { kind: 'dir' });
      return ok();
    }
    if (!initialised) return fatal('not a git repository (or any of the parent directories): .git');
    if (command === 'git rev-parse --git-dir') return ok('.git\n');
    if (command === 'git rev-parse HEAD') {
      return head === null
        ? fatal("ambiguous argument 'HEAD': unknown revision or path not in the working tree.")
        : ok(`${head}\n`);
    }
    if (command === 'git add -A') {
      index = tracked();
      return ok();
    }
    if (command === 'git status --porcelain') {
      return ok(
        nameStatus(headTree(), tracked())
          .map((row) =>
            row.status === 'A' ? `?? ${row.path}\n` : ` ${row.status.charAt(0)} ${row.path}\n`,
          )
          .join(''),
      );
    }
    if (command === 'git ls-files --cached --others --exclude-standard') {
      return ok(
        sorted(tracked())
          .map(([path]) => `${path}\n`)
          .join(''),
      );
    }
    const commit = /^git(?: -c \S+)* commit -q -m "(.*)"$/.exec(command);
    if (commit) {
      if (sameTree(index, headTree())) {
        return { exitCode: 1, result: 'nothing to commit, working tree clean\n' };
      }
      const sha = shaOf(index, head);
      commits.set(sha, { label: commit[1]!, parent: head, tree: new Map(index) });
      head = sha;
      return ok();
    }
    const diffTree = /^git diff-tree --name-status -r -M (\S+ \S+)$/.exec(command);
    if (diffTree) {
      const trees = two(diffTree[1]!);
      if (!Array.isArray(trees)) return trees;
      return ok(
        nameStatus(...trees)
          .map(
            (row) => `${row.status}\t${row.old === undefined ? '' : `${row.old}\t`}${row.path}\n`,
          )
          .join(''),
      );
    }
    const diffQuiet = /^git diff --quiet (\S+ \S+)$/.exec(command);
    if (diffQuiet) {
      const trees = two(diffQuiet[1]!);
      if (!Array.isArray(trees)) return trees;
      return { exitCode: sameTree(...trees) ? 0 : 1, result: '' };
    }
    const diff = /^git diff (\S+ \S+)$/.exec(command);
    if (diff) {
      const trees = two(diff[1]!);
      return Array.isArray(trees) ? ok(unifiedDiff(...trees)) : trees;
    }
    const readTree = /^git read-tree -u --reset (\S+)$/.exec(command);
    if (readTree) {
      const tree = treeOf(readTree[1]!);
      if (tree === undefined) return fatal(`bad object ${readTree[1]!}`);
      index = new Map(tree);
      writeWorktree(tree);
      return ok();
    }
    if (command === `git bundle create ${BUNDLE} --all`) {
      if (head === null) return fatal('Refusing to create empty bundle.');
      daytona.workspace.set(`${root}/${BUNDLE}`, { kind: 'file', content: bundleOf(head) });
      return ok();
    }
    const log = /^git log -1 --format=%s (\S+)$/.exec(command);
    if (log) {
      const found = commits.get(log[1]!);
      return found === undefined ? fatal(`bad object ${log[1]!}`) : ok(`${found.label}\n`);
    }
    // 018's pull: a real bundle lands under `.git/`; only its header is read — the tip ref (HEAD)
    // and the prerequisite — so the fake learns the tip as one commit over the prerequisite, its
    // tree the head's. Enough to fast-forward, list and record it; a packfile is never parsed.
    const fetch = /^git fetch -q (\S+)$/.exec(command);
    if (fetch) {
      const entry = daytona.workspace.get(`${root}/${fetch[1]!}`);
      if (entry?.kind !== 'file') {
        return fatal(`'${fetch[1]!}' does not appear to be a git repository`);
      }
      const header = entry.content.toString('latin1').split('\n\n')[0]!.split('\n').slice(1);
      const prerequisite = header.find((line) => line.startsWith('-'))?.slice(1, 41) ?? null;
      const tip = (
        header.find((line) => line.endsWith(' HEAD')) ??
        header.find((line) => !line.startsWith('-'))
      )?.slice(0, 40);
      if (tip === undefined) return fatal("couldn't find remote ref HEAD");
      if (prerequisite !== null && !commits.has(prerequisite)) {
        commits.set(prerequisite, { label: 'prerequisite', parent: head, tree: headTree() });
      }
      if (!commits.has(tip)) {
        commits.set(tip, {
          label: 'Pulled commit',
          parent: prerequisite ?? head,
          tree: headTree(),
        });
      }
      fetchHead = tip;
      return ok();
    }
    if (command === 'git merge -q --ff-only FETCH_HEAD') {
      if (fetchHead === null) return fatal('FETCH_HEAD: not something we can merge');
      for (let at: string | null = fetchHead; at !== head; at = commits.get(at)?.parent ?? null) {
        if (at === null) return fatal('Not possible to fast-forward, aborting.');
      }
      head = fetchHead;
      index = new Map(headTree());
      writeWorktree(index);
      return ok();
    }
    const revList = /^git rev-list --reverse (\S+)\.\.(\S+)$/.exec(command);
    if (revList) {
      const listed: string[] = [];
      for (let at: string | null = revList[2]!; at !== null && at !== revList[1];) {
        const found = commits.get(at);
        if (found === undefined) return fatal(`bad object ${at}`);
        listed.push(at);
        at = found.parent;
      }
      return ok(
        listed
          .reverse()
          .map((sha) => `${sha}\n`)
          .join(''),
      );
    }
    const lsTree = /^git ls-tree -r -l (\S+)$/.exec(command);
    if (lsTree) {
      const tree = treeOf(lsTree[1]!);
      if (tree === undefined) return fatal(`bad object ${lsTree[1]!}`);
      return ok(
        sorted(tree)
          .map(
            ([path, body]) =>
              `100644 blob ${sha1(body)} ${String(body.length).padStart(7)}\t${path}\n`,
          )
          .join(''),
      );
    }
    return undefined;
  };

  daytona.onExecute((request: ExecuteRequest) => {
    // The pull's last step (`gitRemoveFile`): the bundle leaves the workspace.
    const remove = /^rm -f (\.git\/\S+)$/.exec(request.command);
    if (remove) {
      commands.push(request.command);
      daytona.workspace.delete(`${root}/${remove[1]!}`);
      return { exitCode: 0, result: '' };
    }
    if (!request.command.startsWith('git ')) {
      return fallback
        ? fallback(request)
        : { exitCode: 127, result: `fake git: not scripted: ${request.command}\n` };
    }
    commands.push(request.command);
    return (
      git(request.command) ?? {
        exitCode: 129,
        result: `fake git: unknown git command: ${request.command}\n`,
      }
    );
  });

  return { bundleOf, commands, commits, head: () => head, shaOf };
}
