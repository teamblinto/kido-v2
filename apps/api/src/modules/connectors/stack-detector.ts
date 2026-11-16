import { type RunConfig, runConfigSchema } from '@repo/contracts';

/**
 * Spec 047: what a repository is and how it runs, from its own files.
 *
 * Pure: a snapshot of the clone in, a validated run profile out. No I/O, no clock, no model call.
 * The import runner builds the snapshot from the clone it already has on the worker
 * (`repo-snapshot.ts`), so detection sees the whole tree to a few levels and costs no GitHub calls.
 * The agent's repair run is the fallback for whatever this gets wrong. This step only has to be
 * right for the common cases, and it must never be unsafe.
 *
 * Safety: every value taken from the repository and put into a command (a script name, a module
 * path, a directory) has to match {@link SAFE_TOKEN}, or it is not used. Every command binds
 * `0.0.0.0:PREVIEW_PORT` by flag or by `PORT`/`HOST`, because the preview reaches the sandbox's
 * address, not its loopback.
 */

export interface RepoSnapshot {
  /** POSIX paths of files, relative to the root, vendor and VCS directories excluded. */
  readonly files: readonly string[];
  /** A file's text, or undefined when it is absent, too large or not text. */
  read(path: string): string | undefined;
}

/** The port every run profile this module writes listens on, where the command lets it choose. */
export const PREVIEW_PORT = 3000;

/** A word that may appear in a command: no space, quote, `$` or shell operator, and never `..`. */
const SAFE_TOKEN = /^[\w@][\w@./:+=-]*$/;

const safe = (value: string | undefined): value is string =>
  value !== undefined && SAFE_TOKEN.test(value) && !value.split('/').includes('..');

/** A directory for `root` or a command: the root itself, or a safe relative path. */
const safeDir = (dir: string): boolean => dir === '.' || safe(dir);

type PackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn';

interface PackageJson {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly main?: string;
  readonly name?: string;
  readonly packageManager?: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly workspaces: readonly string[];
}

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
};

const join = (dir: string, name: string): string => (dir === '.' ? name : `${dir}/${name}`);

function record(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** A `package.json` this code can read, or undefined; a broken manifest is not a throw. */
export function parsePackageJson(raw: string | undefined): PackageJson | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const json = parsed as Record<string, unknown>;
  const workspaces = Array.isArray(json.workspaces)
    ? json.workspaces
    : Array.isArray((json.workspaces as { packages?: unknown } | undefined)?.packages)
      ? (json.workspaces as { packages: unknown[] }).packages
      : [];
  return {
    dependencies: { ...record(json.devDependencies), ...record(json.dependencies) },
    ...(typeof json.main === 'string' ? { main: json.main } : {}),
    ...(typeof json.name === 'string' ? { name: json.name } : {}),
    ...(typeof json.packageManager === 'string' ? { packageManager: json.packageManager } : {}),
    scripts: record(json.scripts),
    workspaces: workspaces.filter((entry): entry is string => typeof entry === 'string'),
  };
}

/** `pnpm-workspace.yaml`'s `packages:` list, read line by line — no YAML parser for one list. */
function pnpmWorkspaces(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  let inPackages = false;
  for (const line of raw.split('\n')) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = /^\s*-\s*['"]?([^'"#\s]+)['"]?/.exec(line);
      if (item?.[1] !== undefined) out.push(item[1]);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return out;
}

/** A workspace glob (`apps/*`, `packages/**`, `web`) as a test on a package directory. */
function globMatcher(glob: string): (dir: string) => boolean {
  const clean = glob.replace(/^\.\//, '').replace(/\/$/, '');
  if (clean.startsWith('!')) return () => false;
  const pattern = clean
    .split('/')
    .map((part) =>
      part === '**' ? '.+' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+'),
    )
    .join('/');
  const regex = new RegExp(`^${pattern}$`);
  return (dir) => regex.test(dir);
}

function packageManagerOf(snapshot: RepoSnapshot, root: PackageJson): PackageManager {
  const declared = /^(bun|npm|pnpm|yarn)@/.exec(root.packageManager ?? '')?.[1];
  if (declared !== undefined) return declared as PackageManager;
  const has = (name: string) => snapshot.files.includes(name);
  if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

const PM_BIN: Record<PackageManager, string> = {
  bun: 'npx -y bun@1',
  npm: 'npm',
  // Corepack ships with Node 24 and honours `packageManager`; no global install, so no root needed.
  pnpm: 'corepack pnpm',
  yarn: 'corepack yarn',
};

function installCommand(pm: PackageManager, snapshot: RepoSnapshot): string {
  switch (pm) {
    case 'npm':
      return snapshot.files.includes('package-lock.json') ||
        snapshot.files.includes('npm-shrinkwrap.json')
        ? 'npm ci --no-audit --no-fund'
        : 'npm install --no-audit --no-fund';
    case 'pnpm':
      // pnpm 11+ refuses to install while a dependency's build script is unapproved (esbuild, for
      // one); npm and yarn run them by default, and this runs in the tenant's own sandbox. A
      // repository that manages approvals itself keeps its own rules: pnpm refuses the flag beside
      // them (ERR_PNPM_CONFIG_CONFLICT_BUILT_DEPENDENCIES). Older pnpm ignores an unknown key.
      return managesBuildApprovals(snapshot)
        ? 'corepack pnpm install'
        : 'corepack pnpm install --config.dangerously-allow-all-builds=true';
    case 'yarn':
      return 'corepack yarn install';
    case 'bun':
      return 'npx -y bun@1 install';
  }
}

/** Whether the repository already says which dependencies may run build scripts (pnpm). */
function managesBuildApprovals(snapshot: RepoSnapshot): boolean {
  const pattern =
    /(only|never|ignored)BuiltDependencies|allowBuilds|dangerouslyAllowAllBuilds|(only|never)-built-dependencies/;
  return ['package.json', 'pnpm-workspace.yaml', '.npmrc'].some((file) =>
    pattern.test(snapshot.read(file) ?? ''),
  );
}

/** A port a script sets for itself: `--port 4321`, `-p 4000`, `PORT=4100 …`. */
export function scriptPort(body: string | undefined): number | undefined {
  const port = Number(/(?:--port[=\s]+|(?:^|\s)-p\s+|\bPORT=)(\d{4,5})\b/.exec(body ?? '')?.[1]);
  return Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : undefined;
}

/**
 * The bind flags a script still needs. A script that names its own port keeps it (a second
 * `--port` would reach the CLI as two values), and one that names a host keeps that.
 */
function missingFlags(flags: readonly string[], body: string): string[] {
  const hasPort = scriptPort(body) !== undefined;
  const hasHost = /(^|\s)(--host|-H)(\s|=|$)/.test(body);
  const out: string[] = [];
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!;
    const paired = flag === '--host' || flag === '-H' || flag === '--port' || flag === '-p';
    const skip =
      ((flag === '--host' || flag === '-H') && hasHost) ||
      ((flag === '--port' || flag === '-p' || flag === '--strictPort') && hasPort);
    if (!skip) out.push(...(paired ? [flag, flags[index + 1]!] : [flag]));
    if (paired) index += 1;
  }
  return out;
}

/** `<pm> run <script> [args]` — npm alone needs `--` before arguments meant for the script. */
function runScript(pm: PackageManager, script: string, args: readonly string[] = []): string {
  const extra =
    args.length === 0 ? '' : pm === 'npm' ? ` -- ${args.join(' ')}` : ` ${args.join(' ')}`;
  return `${PM_BIN[pm]} run ${script}${extra}`;
}

/** Runs a dependency's binary without a script: `npx`, or the manager's own `exec`. */
function execBinary(pm: PackageManager, bin: string, args: readonly string[]): string {
  const prefix = pm === 'npm' ? 'npx' : pm === 'bun' ? 'npx -y bun@1 x' : `${PM_BIN[pm]} exec`;
  return `${prefix} ${bin} ${args.join(' ')}`.trim();
}

interface NodeFramework {
  readonly id: string;
  /** The dependency that names it. */
  readonly dep: string;
  /** The binary its dev script starts with, for appending flags. */
  readonly bin?: string;
  /** How to make its dev server bind `0.0.0.0:PREVIEW_PORT`; empty when it honours `PORT`/`HOST`. */
  readonly flags: readonly string[];
  /** Arguments to its binary when no script runs it. */
  readonly devArgs?: readonly string[];
  /** Static output directory for a deploy, relative to the package. */
  readonly output?: string;
  readonly web: boolean;
}

const VITE_FLAGS = ['--host', '0.0.0.0', '--port', String(PREVIEW_PORT), '--strictPort'];

/** Checked in this order: a meta-framework before the bundler it is built on. */
const NODE_FRAMEWORKS: readonly NodeFramework[] = [
  // Next and Nuxt read `PORT` (and Nuxt `HOST`); Next binds every interface by default.
  { bin: 'next', dep: 'next', devArgs: ['dev'], flags: [], id: 'nextjs', web: true },
  { bin: 'nuxt', dep: 'nuxt', devArgs: ['dev'], flags: [], id: 'nuxt', web: true },
  {
    bin: 'remix',
    dep: '@remix-run/dev',
    devArgs: ['vite:dev'],
    flags: VITE_FLAGS.slice(0, 4),
    id: 'remix',
    web: true,
  },
  {
    bin: 'astro',
    dep: 'astro',
    devArgs: ['dev'],
    flags: ['--host', '0.0.0.0', '--port', String(PREVIEW_PORT)],
    id: 'astro',
    output: 'dist',
    web: true,
  },
  {
    bin: 'vite',
    dep: '@sveltejs/kit',
    devArgs: ['dev'],
    flags: VITE_FLAGS,
    id: 'sveltekit',
    web: true,
  },
  {
    bin: 'ng',
    dep: '@angular/core',
    devArgs: ['serve'],
    flags: ['--host', '0.0.0.0', '--port', String(PREVIEW_PORT)],
    id: 'angular',
    web: true,
  },
  {
    bin: 'gatsby',
    dep: 'gatsby',
    devArgs: ['develop'],
    flags: ['-H', '0.0.0.0', '-p', String(PREVIEW_PORT)],
    id: 'gatsby',
    output: 'public',
    web: true,
  },
  // Create React App reads `PORT`, `HOST` and `BROWSER`.
  { dep: 'react-scripts', flags: [], id: 'create-react-app', output: 'build', web: true },
  {
    bin: 'vue-cli-service',
    dep: '@vue/cli-service',
    devArgs: ['serve'],
    flags: ['--host', '0.0.0.0', '--port', String(PREVIEW_PORT)],
    id: 'vue-cli',
    output: 'dist',
    web: true,
  },
  {
    bin: 'expo',
    dep: 'expo',
    devArgs: ['start', '--web'],
    flags: ['--port', String(PREVIEW_PORT)],
    id: 'expo',
    web: true,
  },
  {
    bin: 'vite',
    dep: 'vite',
    devArgs: [],
    flags: VITE_FLAGS,
    id: 'vite',
    output: 'dist',
    web: true,
  },
  // Servers: they read `PORT` themselves or say a literal port, which `literalPort` finds.
  { dep: '@nestjs/core', flags: [], id: 'nestjs', web: false },
  { dep: 'express', flags: [], id: 'express', web: false },
  { dep: 'fastify', flags: [], id: 'fastify', web: false },
  { dep: 'hono', flags: [], id: 'hono', web: false },
  { dep: 'koa', flags: [], id: 'koa', web: false },
];

const UI_LIBRARIES: readonly [string, string][] = [
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['solid-js', 'Solid'],
  ['preact', 'Preact'],
  ['lit', 'Lit'],
];

function frameworkOf(pkg: PackageJson): NodeFramework | undefined {
  return NODE_FRAMEWORKS.find((framework) => pkg.dependencies[framework.dep] !== undefined);
}

function frameworkLabel(pkg: PackageJson, framework: NodeFramework | undefined): string | null {
  if (framework === undefined) return null;
  if (framework.id !== 'vite') return framework.id;
  const ui = UI_LIBRARIES.find(([dep]) => pkg.dependencies[dep] !== undefined)?.[1];
  return ui === undefined ? 'vite' : `vite-${ui.toLowerCase()}`;
}

/**
 * A literal port a server says it listens on (`listen(8080)`, `":8080"`, `port=5000`), or
 * undefined. Only for servers that may ignore `PORT`. A port under 1024 cannot be bound without
 * root, and the agent fixes that one.
 */
export function literalPort(source: string | undefined): number | undefined {
  if (source === undefined) return undefined;
  const patterns = [
    /\.listen\(\s*(\d{4,5})\b/,
    /PORT\s*(?:\|\||\?\?|or)\s*['"]?(\d{4,5})\b/,
    /["'](?:0\.0\.0\.0|localhost|127\.0\.0\.1)?:(\d{4,5})["']/,
    /\bport\s*[=:]\s*(\d{4,5})\b/i,
  ];
  for (const pattern of patterns) {
    const port = Number(pattern.exec(source)?.[1]);
    if (Number.isInteger(port) && port >= 1024 && port <= 65_535) return port;
  }
  return undefined;
}

/** `PORT || 3000` style code honours `PORT`: the preview port is then ours to choose. */
const honoursPortEnv = (source: string | undefined): boolean =>
  source !== undefined &&
  /(process\.env\.PORT|os\.environ|getenv\(\s*["']PORT|env::var\(\s*"PORT)/.test(source);

interface NodePackage {
  readonly dir: string;
  readonly pkg: PackageJson;
}

/** The package a monorepo should preview: a web framework first, then the names apps use. */
function pickApp(candidates: readonly NodePackage[]): NodePackage | undefined {
  const score = ({ dir, pkg }: NodePackage): number => {
    const name = dir.split('/').pop() ?? '';
    const framework = frameworkOf(pkg);
    let total = 0;
    if (framework?.web === true) total += 10;
    else if (framework !== undefined) total += 4;
    if (/^(web|frontend|client|app|site|www|dashboard|ui|portal)$/i.test(name)) total += 3;
    if (dir.startsWith('apps/')) total += 2;
    if (pkg.scripts.dev !== undefined || pkg.scripts.start !== undefined) total += 2;
    if (/(docs|storybook|example|e2e|test|config)/i.test(dir)) total -= 6;
    return total;
  };
  return [...candidates]
    .filter(({ pkg }) => Object.keys(pkg.scripts).length > 0 || frameworkOf(pkg) !== undefined)
    .sort((a, b) => score(b) - score(a) || a.dir.length - b.dir.length)[0];
}

const ENV_EXAMPLES = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
  '.env.dist',
];

/** Variable names an example env file declares — names only, never a value. */
function envNames(snapshot: RepoSnapshot, dirs: readonly string[]): string[] {
  const names = new Set<string>();
  for (const dir of new Set(dirs)) {
    for (const file of ENV_EXAMPLES) {
      for (const line of snapshot.read(join(dir, file))?.split('\n') ?? []) {
        const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
        if (name !== undefined) names.add(name);
      }
    }
  }
  return [...names].slice(0, 100);
}

type Draft = Omit<RunConfig, 'env' | 'repairs' | 'source'>;

/** The packages a root's workspaces (npm, yarn, bun or pnpm) name. */
function workspaceMembers(snapshot: RepoSnapshot, rootPkg: PackageJson): NodePackage[] {
  const globs = [...rootPkg.workspaces, ...pnpmWorkspaces(snapshot.read('pnpm-workspace.yaml'))];
  if (globs.length === 0) return [];
  const tests = globs.map(globMatcher);
  return packagesBelow(snapshot).filter(({ dir }) => tests.some((test) => test(dir)));
}

/** Every package below the root, at whatever depth the snapshot reaches. */
function packagesBelow(snapshot: RepoSnapshot): NodePackage[] {
  const out: NodePackage[] = [];
  for (const path of snapshot.files) {
    if (!path.endsWith('/package.json')) continue;
    const dir = dirOf(path);
    const pkg = safe(dir) ? parsePackageJson(snapshot.read(path)) : undefined;
    if (pkg !== undefined) out.push({ dir, pkg });
  }
  return out;
}

/**
 * Whether a package is an app its framework can serve, not just a manifest naming the framework: a
 * Next.js root with no `app/` or `pages/` (a course repository whose apps are in folders below,
 * say) serves nothing, and plain Vite serves nothing without an `index.html`.
 */
function looksLikeApp(snapshot: RepoSnapshot, { dir, pkg }: NodePackage): boolean {
  const framework = frameworkOf(pkg);
  const under = (prefix: string) =>
    snapshot.files.some((file) => file.startsWith(join(dir, prefix)));
  if (framework?.id === 'nextjs') return ['app/', 'pages/', 'src/app/', 'src/pages/'].some(under);
  if (framework?.id === 'vite') return snapshot.files.includes(join(dir, 'index.html'));
  return true;
}

/**
 * The best web app in a folder below the root, for a repository whose root is not itself one and
 * names no workspaces: `client/` beside `server/`, `frontend/` beside `backend/`, a course of
 * example apps.
 */
function nestedApp(snapshot: RepoSnapshot): NodePackage | undefined {
  return pickApp(
    packagesBelow(snapshot).filter(
      (candidate) => frameworkOf(candidate.pkg)?.web === true && looksLikeApp(snapshot, candidate),
    ),
  );
}

/** The snapshot as seen from `dir`, so a nested app is detected exactly as a root one is. */
function below(snapshot: RepoSnapshot, dir: string): RepoSnapshot {
  const prefix = `${dir}/`;
  return {
    files: snapshot.files
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length)),
    read: (path) => snapshot.read(`${prefix}${path}`),
  };
}

/**
 * A nested app: detected from its own folder, installed there (`cd` then its install, which the
 * supervisor runs from the workspace root), served from there. No static deploy: the build runner
 * builds from the root.
 */
function detectNested(snapshot: RepoSnapshot, dir: string): Draft {
  const sub = below(snapshot, dir);
  const draft = detectNode(sub, parsePackageJson(sub.read('package.json'))!);
  return {
    ...draft,
    build: null,
    install: draft.install === null ? null : `cd ${dir} && ${draft.install}`,
    root: draft.root === '.' ? dir : `${dir}/${draft.root}`,
  };
}

/** A root package that can be previewed: a workspace app, or an app with something to run. */
function rootIsApp(snapshot: RepoSnapshot, rootPkg: PackageJson): boolean {
  if (pickApp(workspaceMembers(snapshot, rootPkg)) !== undefined) return true;
  const root = { dir: '.', pkg: rootPkg };
  const runnable =
    ['dev', 'start', 'serve', 'develop'].some((name) => rootPkg.scripts[name] !== undefined) ||
    rootPkg.main !== undefined ||
    frameworkOf(rootPkg) !== undefined;
  return runnable && looksLikeApp(snapshot, root);
}

function detectNode(snapshot: RepoSnapshot, rootPkg: PackageJson): Draft {
  const pm = packageManagerOf(snapshot, rootPkg);
  const members = workspaceMembers(snapshot, rootPkg);

  // A monorepo previews its best app package; a root that is itself the app (a framework of its
  // own, with nothing better in its workspaces) previews from the root.
  const app = pickApp(members);
  const rootFramework = frameworkOf(rootPkg);
  const useApp =
    app !== undefined && !(rootFramework?.web === true && frameworkOf(app.pkg)?.web !== true);
  const target: NodePackage = useApp ? app : { dir: '.', pkg: rootPkg };
  const framework = frameworkOf(target.pkg);
  const install = installCommand(pm, snapshot);
  const stack = {
    framework: frameworkLabel(target.pkg, framework),
    language: target.pkg.dependencies.typescript !== undefined ? 'typescript' : 'javascript',
    packageManager: pm,
  };
  const base = { build: null, install, root: target.dir, stack };

  const scripts = ['dev', 'start', 'serve', 'develop'].filter(
    (name) => target.pkg.scripts[name] !== undefined && safe(name),
  );
  /** The first of those scripts whose command *is* the framework's binary, flags appended safely. */
  const direct = scripts.find(
    (name) =>
      framework?.bin !== undefined &&
      target.pkg.scripts[name]!.trim().split(/\s+/)[0] === framework.bin,
  );

  let dev: string | undefined;
  if (framework !== undefined && framework.flags.length > 0) {
    // A script that *is* the binary takes the bind flags appended; anything wrapped around it
    // (`concurrently`, a pre-step) would take them in the wrong place, so the binary runs directly.
    dev =
      direct !== undefined
        ? runScript(pm, direct, missingFlags(framework.flags, target.pkg.scripts[direct]!))
        : framework.bin === undefined
          ? undefined
          : execBinary(pm, framework.bin, [...(framework.devArgs ?? []), ...framework.flags]);
  } else if (scripts.includes('dev')) {
    dev = runScript(pm, 'dev');
  } else if (framework?.bin !== undefined && framework.devArgs !== undefined) {
    // No `dev` script: the framework's own dev server, never `start` — for Next or Nuxt that is
    // the production server, which needs a build first.
    dev = execBinary(pm, framework.bin, framework.devArgs);
  } else if (scripts[0] !== undefined) {
    // Create React App's `start`, a server's `start`.
    dev = runScript(pm, scripts[0]);
  } else if (safe(target.pkg.main) && snapshot.files.includes(join(target.dir, target.pkg.main))) {
    dev = `node ${target.pkg.main}`;
  }

  if (dev === undefined) {
    // A package with nothing to run but an `index.html` is a static site; otherwise a library.
    if (snapshot.files.includes(join(target.dir, 'index.html'))) {
      return {
        ...base,
        dev: staticServer(),
        port: PREVIEW_PORT,
        stack: { ...stack, framework: 'static' },
      };
    }
    return { ...base, dev: null, port: null };
  }

  // A server that names its own port and ignores `PORT` is previewed where it listens.
  // A script that sets its own port is previewed there (`cross-env PORT=4100 react-scripts start`).
  const ran = scripts.find((name) => dev?.includes(` run ${name}`));
  const declared = ran === undefined ? undefined : scriptPort(target.pkg.scripts[ran]);
  let port = declared ?? PREVIEW_PORT;
  if (declared === undefined && framework?.web !== true) {
    const entry = [
      target.pkg.main,
      'server.js',
      'index.js',
      'src/index.ts',
      'src/server.ts',
      'src/main.ts',
      'index.ts',
      'server.ts',
      'app.js',
    ]
      .filter(safe)
      .map((file) => snapshot.read(join(target.dir, file)))
      .find((source) => source !== undefined);
    const literal = literalPort(entry);
    if (literal !== undefined && !honoursPortEnv(entry)) port = literal;
  }

  const build =
    target.dir === '.' && framework?.output !== undefined && target.pkg.scripts.build !== undefined
      ? { command: runScript(pm, 'build'), output: framework.output }
      : null;

  return { ...base, build, dev, port };
}

const staticServer = (): string => `python3 -m http.server ${String(PREVIEW_PORT)} --bind 0.0.0.0`;

const PY_MANIFESTS = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'] as const;

/** The module path for a Python file (`app/main.py` → `app.main`), or undefined if unsafe. */
const modulePath = (file: string): string | undefined => {
  const dotted = file.replace(/\.py$/, '').replace(/\//g, '.');
  return /^[A-Za-z_][\w.]*$/.test(dotted) ? dotted : undefined;
};

function detectPython(snapshot: RepoSnapshot): Draft {
  const has = (name: string) => snapshot.files.includes(name);
  const pyproject = snapshot.read('pyproject.toml') ?? '';
  const manifests = [
    snapshot.read('requirements.txt'),
    pyproject,
    snapshot.read('Pipfile'),
    snapshot.read('setup.py'),
  ]
    .join('\n')
    .toLowerCase();
  const depends = (name: string) =>
    new RegExp(`(^|[\\s"'\\[,])${name}([\\s"'<>=~!\\],;\\[]|$)`, 'm').test(manifests);

  const venv = 'python3 -m venv .venv';
  const pip = '.venv/bin/pip install -q';
  let install: string;
  let packageManager: string;
  if (has('requirements.txt')) {
    install = `${venv} && ${pip} -r requirements.txt`;
    packageManager = 'pip';
  } else if (pyproject.includes('[tool.poetry]') && !/^\s*\[project\]/m.test(pyproject)) {
    install = `${venv} && ${pip} poetry && POETRY_VIRTUALENVS_CREATE=false .venv/bin/poetry install --no-root --no-interaction`;
    packageManager = 'poetry';
  } else if (has('pyproject.toml')) {
    install = `${venv} && ${pip} uv && .venv/bin/uv pip install -r pyproject.toml`;
    packageManager = 'uv';
  } else if (has('Pipfile')) {
    install = `${venv} && ${pip} pipenv && .venv/bin/pipenv requirements --dev > .venv/requirements.txt && ${pip} -r .venv/requirements.txt`;
    packageManager = 'pipenv';
  } else {
    install = `${venv} && ${pip} -e .`;
    packageManager = 'pip';
  }

  const pyFiles = snapshot.files.filter(
    (file) => file.endsWith('.py') && file.split('/').length <= 3,
  );
  const find = (preferred: readonly string[], test: RegExp) =>
    [...preferred.filter((file) => pyFiles.includes(file)), ...pyFiles].find((file) =>
      test.test(snapshot.read(file) ?? ''),
    );
  const port = String(PREVIEW_PORT);
  const stack = (framework: string | null) => ({ framework, language: 'python', packageManager });
  const base = { build: null, root: '.' };
  /** A server the manifests do not name is installed beside them, so the command can run. */
  const plus = (dep: string) => (depends(dep) ? install : `${install} && ${pip} ${dep}`);

  const manage = pyFiles.find((file) => file.endsWith('manage.py'));
  if (depends('django') && manage !== undefined && safeDir(dirOf(manage))) {
    const python =
      dirOf(manage) === '.'
        ? '.venv/bin/python'
        : '../'.repeat(dirOf(manage).split('/').length) + '.venv/bin/python';
    return {
      ...base,
      dev: `${python} manage.py migrate --noinput; ${python} manage.py runserver 0.0.0.0:${port}`,
      install,
      port: PREVIEW_PORT,
      root: dirOf(manage),
      stack: stack('django'),
    };
  }

  if (depends('fastapi')) {
    const file = find(
      ['main.py', 'app.py', 'app/main.py', 'src/main.py', 'api/main.py', 'server.py'],
      /\bFastAPI\s*\(/,
    );
    const variable =
      file === undefined
        ? undefined
        : /^(\w+)\s*(?::[^=]+)?=\s*FastAPI\s*\(/m.exec(snapshot.read(file) ?? '')?.[1];
    const module = file === undefined ? undefined : modulePath(file);
    if (module !== undefined && variable !== undefined) {
      return {
        ...base,
        dev: `.venv/bin/uvicorn ${module}:${variable} --host 0.0.0.0 --port ${port} --reload`,
        install: plus('uvicorn'),
        port: PREVIEW_PORT,
        stack: stack('fastapi'),
      };
    }
  }

  if (depends('streamlit')) {
    const file = find(
      ['streamlit_app.py', 'app.py', 'main.py', 'Home.py'],
      /import streamlit|from streamlit/,
    );
    if (safe(file)) {
      return {
        ...base,
        dev: `.venv/bin/streamlit run ${file} --server.port ${port} --server.address 0.0.0.0 --server.headless true`,
        install,
        port: PREVIEW_PORT,
        stack: stack('streamlit'),
      };
    }
  }

  if (depends('gradio')) {
    const file = find(['app.py', 'main.py'], /import gradio|from gradio/);
    if (safe(file)) {
      return {
        ...base,
        dev: `GRADIO_SERVER_NAME=0.0.0.0 GRADIO_SERVER_PORT=${port} .venv/bin/python ${file}`,
        install,
        port: PREVIEW_PORT,
        stack: stack('gradio'),
      };
    }
  }

  if (depends('flask')) {
    const file = find(
      ['app.py', 'main.py', 'wsgi.py', 'app/__init__.py', 'run.py', 'server.py'],
      /\bFlask\s*\(/,
    );
    const module =
      file === undefined ? undefined : modulePath(file.replace(/\/__init__\.py$/, '.py'));
    if (module !== undefined) {
      return {
        ...base,
        dev: `.venv/bin/flask --app ${module} run --host 0.0.0.0 --port ${port} --debug`,
        install,
        port: PREVIEW_PORT,
        stack: stack('flask'),
      };
    }
  }

  // A script, a library or a CLI: installed, nothing to preview.
  return { ...base, dev: null, install, port: null, stack: stack(null) };
}

/** Pinned so an import is reproducible; `GOTOOLCHAIN=auto` fetches a newer one a `go.mod` asks for. */
const GO_VERSION = '1.23.4';

const ARCH = `$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')`;

function detectGo(snapshot: RepoSnapshot): Draft {
  const install =
    `command -v go >/dev/null || (mkdir -p $HOME/.local && curl -fsSL https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz | tar -C $HOME/.local -xz)` +
    ' && go mod download';
  const mains = snapshot.files.filter((file) => file.endsWith('main.go'));
  const main = mains.includes('main.go')
    ? 'main.go'
    : (mains.find((file) => /^cmd\/[\w.-]+\/main\.go$/.test(file)) ?? mains[0]);
  const stack = { framework: null, language: 'go', packageManager: 'go' };
  if (main === undefined || !safeDir(dirOf(main))) {
    return { build: null, dev: null, install, port: null, root: '.', stack };
  }
  const source = snapshot.read(main);
  const literal = honoursPortEnv(source) ? undefined : literalPort(source);
  const target = dirOf(main) === '.' ? '.' : `./${dirOf(main)}`;
  return {
    build: null,
    dev: `go run ${target}`,
    install,
    port: literal ?? PREVIEW_PORT,
    root: '.',
    stack,
  };
}

function detectRust(snapshot: RepoSnapshot): Draft {
  const install =
    'command -v cargo >/dev/null || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal';
  const main = snapshot.read('src/main.rs');
  const stack = { framework: null, language: 'rust', packageManager: 'cargo' };
  if (main === undefined) return { build: null, dev: null, install, port: null, root: '.', stack };
  const literal = honoursPortEnv(main) ? undefined : literalPort(main);
  return {
    build: null,
    dev: 'cargo run',
    install: `${install} && cargo fetch`,
    port: literal ?? PREVIEW_PORT,
    root: '.',
    stack,
  };
}

function detectDeno(snapshot: RepoSnapshot): Draft {
  const raw = snapshot.read('deno.json') ?? snapshot.read('deno.jsonc') ?? '';
  const install =
    'command -v deno >/dev/null || curl -fsSL https://deno.land/install.sh | sh -s -- -y';
  const task = ['dev', 'start'].find((name) => new RegExp(`"${name}"\\s*:`).test(raw));
  const stack = {
    framework: raw.includes('fresh') ? 'fresh' : null,
    language: 'typescript',
    packageManager: 'deno',
  };
  return task === undefined
    ? { build: null, dev: null, install, port: null, root: '.', stack }
    : { build: null, dev: `deno task ${task}`, install, port: PREVIEW_PORT, root: '.', stack };
}

/** Languages the sandbox has no user-space toolchain for: named, so the person can be told. */
const UNSUPPORTED: readonly [string, string, string | null][] = [
  ['Gemfile', 'ruby', 'rails'],
  ['composer.json', 'php', 'laravel'],
  ['pom.xml', 'java', 'maven'],
  ['build.gradle', 'java', 'gradle'],
  ['build.gradle.kts', 'kotlin', 'gradle'],
  ['mix.exs', 'elixir', 'phoenix'],
];

/**
 * The run profile for a repository. The answer always passes `runConfigSchema`: a value that would
 * not (a command over the length limit, say) leaves the dev server undeclared rather than throwing.
 */
export function detectRunConfig(snapshot: RepoSnapshot): RunConfig {
  const has = (name: string) => snapshot.files.includes(name);
  const rootPkg = parsePackageJson(snapshot.read('package.json'));
  let draft: Draft;

  const nested = () => nestedApp(snapshot);
  let inner: NodePackage | undefined;

  if (has('deno.json') || has('deno.jsonc')) draft = detectDeno(snapshot);
  else if (rootPkg !== undefined) {
    inner = rootIsApp(snapshot, rootPkg) ? undefined : nested();
    draft = inner === undefined ? detectNode(snapshot, rootPkg) : detectNested(snapshot, inner.dir);
  } else if (PY_MANIFESTS.some(has) || has('manage.py')) draft = detectPython(snapshot);
  else if (has('go.mod')) draft = detectGo(snapshot);
  else if (has('Cargo.toml')) draft = detectRust(snapshot);
  else if ((inner = nested()) !== undefined) draft = detectNested(snapshot, inner.dir);
  else {
    const unsupported = UNSUPPORTED.find(([file]) => has(file));
    if (unsupported !== undefined) {
      const [, language, framework] = unsupported;
      const named =
        framework === 'rails'
          ? (snapshot.read('Gemfile') ?? '').includes('rails')
          : framework === 'laravel'
            ? (snapshot.read('composer.json') ?? '').includes('laravel')
            : true;
      draft = {
        build: null,
        dev: null,
        install: null,
        port: null,
        root: '.',
        stack: { framework: named ? framework : null, language, packageManager: null },
      };
    } else if (has('index.html')) {
      draft = {
        build: null,
        dev: staticServer(),
        install: null,
        port: PREVIEW_PORT,
        root: '.',
        stack: { framework: 'static', language: 'html', packageManager: null },
      };
    } else {
      draft = {
        build: null,
        dev: null,
        install: null,
        port: null,
        root: '.',
        stack: { framework: null, language: 'unknown', packageManager: null },
      };
    }
  }

  const config = {
    ...draft,
    env: envNames(snapshot, ['.', draft.root]),
    repairs: 0,
    source: 'detected' as const,
  };
  const parsed = runConfigSchema.safeParse(config);
  return parsed.success
    ? parsed.data
    : runConfigSchema.parse({ ...config, build: null, dev: null, port: null });
}
