import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { RunConfig } from '@repo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { snapshotDirectory } from '../src/modules/connectors/repo-snapshot';
import { detectRunConfig } from '../src/modules/connectors/stack-detector';
import { resolveDevServer } from '../src/modules/sandbox/run-config';
import { devServerEnvLines } from '../src/modules/sandbox/sandbox-ops.consumer';
import type { TemplateCatalogue } from '../src/modules/sandbox/template-catalogue';

/**
 * Spec 047 against the real sandbox image: does a detected run profile actually install and serve
 * inside `forge/sandbox-base` — uid 1000, no root, no toolchain but Node and Python?
 *
 * Each case writes a repository, detects its profile with the production detector, copies the tree
 * into a fresh container of the image, and runs the production supervisor with exactly the env
 * file a claim writes. The supervisor's callback reports are collected over HTTP, and the app is
 * then fetched from the container's own network address — not its loopback — because that is the
 * address the preview gateway dials.
 *
 * Opt-in, like the other `*-real` suites: set `SMART_IMPORT_SANDBOX_IMAGE` to the image tag
 * (`forge/sandbox-base:1`). Installs reach the public registries, so a case can take minutes.
 */
const IMAGE = process.env.SMART_IMPORT_SANDBOX_IMAGE;

if (IMAGE === undefined) {
  process.stderr.write(
    'SANDBOX-IMAGE-SKIP "smart-import-sandbox-real": SMART_IMPORT_SANDBOX_IMAGE not set\n',
  );
}

const SUPERVISOR = join(__dirname, '../src/modules/sandbox/dev-supervisor.mjs');
const WORKSPACE = '/home/daytona/workspace';
/** Short budgets so the broken case reaches `failed` in seconds; installs are not timed by these. */
const TIMINGS = {
  backoffBaseMs: 300,
  coldRetryMs: 600_000,
  logCapBytes: 4_194_304,
  probeIntervalMs: 500,
  stableResetMs: 60_000,
  startAttempts: 2,
};
const catalogue = { get: () => ({ manifest: {} }) } as unknown as TemplateCatalogue;

/**
 * Real public repositories, opt-in with `SMART_IMPORT_REAL_REPOS=1`: other people's code, with
 * whatever their dependencies do on today's Node. They are not asserted to serve — a repository
 * that needs secrets or an old runtime is exactly what the repair run is for — only to reach a
 * verdict (`listening` or `failed`), and the outcome is written to `SMART_IMPORT_RESULTS`.
 */
const REAL_REPOS =
  process.env.SMART_IMPORT_REAL_REPOS === '1'
    ? [
        'sveltejs/realworld',
        'fastapi/full-stack-fastapi-template',
        'vercel/next-learn',
        'gothinkster/react-redux-realworld-example-app',
      ]
    : [];

const json = (value: unknown) => JSON.stringify(value, null, 2);

interface Case {
  readonly name: string;
  /** A public GitHub repository to clone instead of `files`; its outcome is recorded, not asserted. */
  readonly clone?: string;
  readonly files: Record<string, string>;
  /** What detection must say, before anything runs. */
  readonly detects: Partial<Omit<RunConfig, 'stack'>> & { stack: Partial<RunConfig['stack']> };
  /** Text the served page must contain; undefined for a case that must end `failed`. */
  readonly marker?: string;
}

const CASES: readonly Case[] = [
  {
    detects: { root: '.', stack: { framework: 'vite-react', packageManager: 'npm' } },
    files: {
      'index.html':
        '<!doctype html><title>vite-react-ok</title><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
      'package.json': json({
        dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
        devDependencies: { '@vitejs/plugin-react': '^4.3.4', vite: '^6.0.0' },
        name: 'vite-react',
        scripts: { build: 'vite build', dev: 'vite' },
        type: 'module',
      }),
      'src/main.jsx':
        "import { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')).render('hi');\n",
      'vite.config.js':
        "import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };\n",
    },
    marker: 'vite-react-ok',
    name: 'Vite + React with npm',
  },
  {
    detects: { root: 'apps/web', stack: { framework: 'vite-vue', packageManager: 'pnpm' } },
    files: {
      'apps/web/index.html':
        '<!doctype html><title>monorepo-vue-ok</title><div id="app"></div><script type="module" src="/src/main.js"></script>',
      'apps/web/package.json': json({
        dependencies: { '@mono/ui': 'workspace:*', vue: '^3.5.0' },
        devDependencies: { '@vitejs/plugin-vue': '^5.2.0', vite: '^6.0.0' },
        name: 'web',
        scripts: { dev: 'vite' },
        type: 'module',
      }),
      'apps/web/src/main.js':
        "import { createApp, h } from 'vue';\nimport { label } from '@mono/ui';\ncreateApp({ render: () => h('p', label) }).mount('#app');\n",
      'apps/web/vite.config.js':
        "import vue from '@vitejs/plugin-vue';\nexport default { plugins: [vue()] };\n",
      'package.json': json({ name: 'mono', private: true, scripts: { dev: 'pnpm -r dev' } }),
      'packages/ui/index.js': "export const label = 'from the ui package';\n",
      'packages/ui/package.json': json({
        main: 'index.js',
        name: '@mono/ui',
        type: 'module',
        version: '0.0.0',
      }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    },
    marker: 'monorepo-vue-ok',
    name: 'pnpm monorepo previewing apps/web (Vue)',
  },
  {
    detects: { port: 8080, stack: { framework: 'express', packageManager: 'yarn' } },
    files: {
      'index.js':
        "const express = require('express');\nconst app = express();\napp.get('/', (_req, res) => res.send('express-ok'));\napp.listen(8080);\n",
      'package.json': json({
        dependencies: { express: '^4.21.0' },
        main: 'index.js',
        scripts: { start: 'node index.js' },
      }),
      'yarn.lock': '',
    },
    marker: 'express-ok',
    name: 'Express on a literal port with yarn',
  },
  {
    detects: { stack: { framework: 'fastapi', packageManager: 'pip' } },
    files: {
      'app/__init__.py': '',
      'app/main.py':
        "from fastapi import FastAPI\nfrom fastapi.responses import PlainTextResponse\n\napp = FastAPI()\n\n\n@app.get('/', response_class=PlainTextResponse)\ndef root():\n    return 'fastapi-ok'\n",
      'requirements.txt': 'fastapi\n',
    },
    marker: 'fastapi-ok',
    name: 'FastAPI with requirements.txt (uvicorn added)',
  },
  {
    detects: { stack: { framework: 'flask', packageManager: 'uv' } },
    files: {
      'app.py':
        "from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.get('/')\ndef index():\n    return 'flask-ok'\n",
      'pyproject.toml':
        '[project]\nname = "flaskapp"\nversion = "0.1.0"\ndependencies = ["flask>=3"]\n',
    },
    marker: 'flask-ok',
    name: 'Flask with a PEP 621 pyproject (uv)',
  },
  {
    detects: { stack: { framework: 'django', packageManager: 'pip' } },
    files: {
      'manage.py':
        "import os\nimport sys\n\nif __name__ == '__main__':\n    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')\n    from django.core.management import execute_from_command_line\n    execute_from_command_line(sys.argv)\n",
      'mysite/__init__.py': '',
      'mysite/settings.py':
        "SECRET_KEY = 'dev'\nDEBUG = True\nALLOWED_HOSTS = ['*']\nROOT_URLCONF = 'mysite.urls'\nINSTALLED_APPS = []\nDATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': 'db.sqlite3'}}\n",
      'mysite/urls.py':
        "from django.http import HttpResponse\nfrom django.urls import path\n\nurlpatterns = [path('', lambda request: HttpResponse('django-ok'))]\n",
      'requirements.txt': 'Django>=5,<6\n',
    },
    marker: 'django-ok',
    name: 'Django with migrate then runserver',
  },
  {
    detects: { install: null, stack: { framework: 'static', language: 'html' } },
    files: { 'index.html': '<!doctype html><h1>static-ok</h1>', 'style.css': 'h1 { color: red }' },
    marker: 'static-ok',
    name: 'Static site',
  },
  {
    detects: { stack: { language: 'go' } },
    files: {
      'go.mod': 'module example.com/hello\n\ngo 1.22\n',
      'main.go':
        'package main\n\nimport (\n\t"fmt"\n\t"net/http"\n\t"os"\n)\n\nfunc main() {\n\thttp.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "go-ok") })\n\thttp.ListenAndServe(":"+os.Getenv("PORT"), nil)\n}\n',
    },
    marker: 'go-ok',
    name: 'Go with a user-space toolchain',
  },
  {
    detects: { stack: { language: 'javascript' } },
    files: {
      'package.json': json({
        dependencies: { 'forge-047-this-package-does-not-exist': '1.0.0' },
        scripts: { dev: 'node index.js' },
      }),
    },
    name: 'A repository whose install fails ends failed (the repair trigger)',
  },
];

const ALL_CASES: readonly Case[] = [
  ...CASES,
  ...REAL_REPOS.map((repo) => ({
    clone: repo,
    detects: { stack: {} },
    files: {},
    marker: '',
    name: repo,
  })),
];

function docker(args: readonly string[], input?: string): string {
  return execFileSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

describe.skipIf(IMAGE === undefined)('smart import in the real sandbox image', () => {
  const reports = new Map<string, string[]>();
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        const token = (request.headers.authorization ?? '').replace('Bearer ', '');
        const state = (JSON.parse(body || '{}') as { state?: string }).state ?? '?';
        reports.set(token, [...(reports.get(token) ?? []), state]);
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it.concurrent.each(ALL_CASES)(
    '$name',
    async ({ clone, detects, files, marker, name }) => {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40);
      const dir = mkdtempSync(join(tmpdir(), 'forge-047-'));
      const container = `forge-047-${slug}-${String(Date.now())}`;
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      if (clone !== undefined) {
        execFileSync('git', [
          'clone',
          '-q',
          '--depth',
          '1',
          `https://github.com/${clone}.git`,
          dir,
        ]);
        rmSync(join(dir, '.git'), { force: true, recursive: true });
      }

      const config = detectRunConfig(snapshotDirectory(dir));
      expect(config, 'detection').toMatchObject(detects);
      const dev = resolveDevServer(catalogue, { runConfig: config, template: null });
      expect(dev, 'a dev server is declared').toBeDefined();

      try {
        docker([
          'run',
          '-d',
          '--add-host',
          'host.docker.internal:host-gateway',
          '--name',
          container,
          IMAGE!,
          'sleep',
          'infinity',
        ]);
        docker(['exec', container, 'mkdir', '-p', WORKSPACE]);
        docker(['cp', `${dir}/.`, `${container}:${WORKSPACE}`]);
        // `docker cp` writes as root; a claimed sandbox's workspace belongs to uid 1000.
        docker(['exec', '-u', '0', container, 'chown', '-R', '1000:1000', WORKSPACE]);
        docker([
          'exec',
          '-w',
          WORKSPACE,
          container,
          'sh',
          '-c',
          'git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm import',
        ]);
        docker(['cp', SUPERVISOR, `${container}:/tmp/forge-devserver.mjs`]);
        const env = [
          `FORGE_CALLBACK_TOKEN=${slug}`,
          `FORGE_CALLBACK_URL=http://host.docker.internal:${String(port)}/cb`,
          ...devServerEnvLines(dev!, TIMINGS),
        ];
        docker(
          ['exec', '-i', container, 'sh', '-c', 'cat > /tmp/forge-callback.env'],
          `${env.join('\n')}\n`,
        );
        docker(['exec', '-w', WORKSPACE, container, 'node', '/tmp/forge-devserver.mjs']);

        const settled = await waitFor(() => {
          const states = reports.get(slug) ?? [];
          return states.includes('listening') || states.includes('failed') ? states : undefined;
        }, 12 * 60_000);
        const log = () =>
          docker(['exec', container, 'tail', '-c', '4000', '/tmp/forge-devserver.log']);

        if (clone !== undefined) {
          const served = settled.includes('listening')
            ? spawnSync(
                'docker',
                [
                  'exec',
                  container,
                  'sh',
                  '-c',
                  `curl -sS -o /dev/null -w '%{http_code}' --max-time 60 http://$(hostname -i):${dev!.port}/`,
                ],
                { encoding: 'utf8' },
              ).stdout
            : 'none';
          const results = process.env.SMART_IMPORT_RESULTS;
          if (results !== undefined) {
            const { appendFileSync } = await import('node:fs');
            appendFileSync(
              results,
              `${clone}\t${JSON.stringify(config.stack)}\troot=${config.root}\treports=${settled.join(',')}\thttp=${served}\n${settled.includes('failed') ? log().slice(-1500) : ''}\n`,
            );
          }
          expect(['listening', 'failed'].some((state) => settled.includes(state))).toBe(true);
          return;
        }

        if (marker === undefined) {
          expect(settled, log()).toContain('failed');
          expect(settled[0]).toBe('installing');
          return;
        }

        expect(settled, log()).toContain('listening');
        if (config.install !== null) expect(settled[0]).toBe('installing');

        // From the container's own address, as the gateway dials it: a loopback-only server fails.
        const body = await waitFor(() => {
          const ran = spawnSync(
            'docker',
            [
              'exec',
              container,
              'sh',
              '-c',
              `curl -fsS --max-time 20 http://$(hostname -i):${dev!.port}/`,
            ],
            { encoding: 'utf8' },
          );
          return ran.status === 0 && ran.stdout.includes(marker) ? ran.stdout : undefined;
        }, 120_000);
        expect(body, log()).toContain(marker);

        // Installed dependencies never reach a commit.
        const status = docker(['exec', '-w', WORKSPACE, container, 'git', 'status', '--porcelain']);
        expect(status).not.toMatch(/node_modules|\.venv|__pycache__/);
        expect(readFileSync(SUPERVISOR, 'utf8')).toContain('ensureGitExclude');
      } finally {
        spawnSync('docker', ['rm', '-f', container]);
        rmSync(dir, { force: true, recursive: true });
      }
    },
    15 * 60_000,
  );
});

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
