import { runConfigSchema } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { snapshotOf } from './repo-snapshot';
import { detectRunConfig, literalPort } from './stack-detector';

const pkg = (body: Record<string, unknown>): string => JSON.stringify(body);

/**
 * Spec 047: one fixture per stack the detector claims, read back as the run profile a sandbox would
 * receive. Every answer is also run through `runConfigSchema`, because the detector's promise is
 * that its output is always a profile the platform accepts.
 */
describe('detectRunConfig', () => {
  const detect = (files: Record<string, string>) => {
    const config = detectRunConfig(snapshotOf(files));
    expect(runConfigSchema.safeParse(config).success).toBe(true);
    return config;
  };

  it('a Next.js app with npm: installs from the lockfile and lets Next read PORT', () => {
    const config = detect({
      'next.config.mjs': '',
      'package-lock.json': '{}',
      'package.json': pkg({
        dependencies: { next: '15.0.0', react: '19.0.0' },
        devDependencies: { typescript: '5' },
        scripts: { build: 'next build', dev: 'next dev' },
      }),
    });

    expect(config).toMatchObject({
      dev: 'npm run dev',
      install: 'npm ci --no-audit --no-fund',
      port: 3000,
      root: '.',
      source: 'detected',
      stack: { framework: 'nextjs', language: 'typescript', packageManager: 'npm' },
    });
  });

  it('a Vite React app with pnpm: the bind flags go after the script, with no `--`', () => {
    const config = detect({
      'pnpm-lock.yaml': '',
      'package.json': pkg({
        dependencies: { react: '19' },
        devDependencies: { vite: '6' },
        scripts: { build: 'vite build', dev: 'vite' },
      }),
    });

    expect(config).toMatchObject({
      build: { command: 'corepack pnpm run build', output: 'dist' },
      dev: 'corepack pnpm run dev --host 0.0.0.0 --port 3000 --strictPort',
      install: 'corepack pnpm install --config.dangerously-allow-all-builds=true',
      stack: { framework: 'vite-react', packageManager: 'pnpm' },
    });
  });

  it('a Vite app with npm takes the flags after `--`', () => {
    const config = detect({
      'package.json': pkg({ devDependencies: { vite: '6', vue: '3' }, scripts: { dev: 'vite' } }),
    });

    expect(config.dev).toBe('npm run dev -- --host 0.0.0.0 --port 3000 --strictPort');
    expect(config.install).toBe('npm install --no-audit --no-fund');
    expect(config.stack.framework).toBe('vite-vue');
  });

  it('a wrapped dev script runs the framework binary directly, so the flags land on it', () => {
    const config = detect({
      'yarn.lock': '',
      'package.json': pkg({
        devDependencies: { vite: '6' },
        scripts: { dev: 'concurrently "vite" "tsc -w"' },
      }),
    });

    expect(config.dev).toBe('corepack yarn exec vite --host 0.0.0.0 --port 3000 --strictPort');
  });

  it('Next.js with only a start script runs `next dev`, never the production server', () => {
    const config = detect({
      'package.json': pkg({
        dependencies: { next: '15', react: '19' },
        scripts: { build: 'next build', start: 'next start' },
      }),
    });

    expect(config.dev).toBe('npx next dev');
  });

  it('a script that sets its own port is previewed there, and keeps it', () => {
    const cra = detect({
      'package.json': pkg({
        dependencies: { 'react-scripts': '5' },
        scripts: { start: 'cross-env PORT=4100 react-scripts start' },
      }),
    });
    expect(cra).toMatchObject({ dev: 'npm run start', port: 4100 });

    // Vite with its own --port gets only the host flag: a second --port would reach the CLI twice.
    const vite = detect({
      'package.json': pkg({ devDependencies: { vite: '6' }, scripts: { dev: 'vite --port 5173' } }),
    });
    expect(vite).toMatchObject({ dev: 'npm run dev -- --host 0.0.0.0', port: 5173 });
  });

  it('a pnpm repository that manages build approvals itself keeps its own rules', () => {
    const config = detect({
      'package.json': pkg({
        pnpm: { onlyBuiltDependencies: ['esbuild'] },
        scripts: { dev: 'node x.js' },
      }),
      'pnpm-lock.yaml': '',
    });

    expect(config.install).toBe('corepack pnpm install');
  });

  it('Create React App reads PORT and HOST itself', () => {
    const config = detect({
      'package.json': pkg({
        dependencies: { react: '18', 'react-scripts': '5' },
        scripts: { build: 'react-scripts build', start: 'react-scripts start' },
      }),
    });

    expect(config).toMatchObject({
      build: { output: 'build' },
      dev: 'npm run start',
      stack: { framework: 'create-react-app' },
    });
  });

  it('Astro, SvelteKit and Angular each get their own bind flags', () => {
    expect(
      detect({
        'package.json': pkg({ dependencies: { astro: '4' }, scripts: { dev: 'astro dev' } }),
      }).dev,
    ).toBe('npm run dev -- --host 0.0.0.0 --port 3000');
    expect(
      detect({
        'package.json': pkg({
          devDependencies: { '@sveltejs/kit': '2', vite: '5' },
          scripts: { dev: 'vite dev' },
        }),
      }).stack.framework,
    ).toBe('sveltekit');
    expect(
      detect({
        'package.json': pkg({
          dependencies: { '@angular/core': '18' },
          scripts: { start: 'ng serve' },
        }),
      }).dev,
    ).toBe('npm run start -- --host 0.0.0.0 --port 3000');
  });

  it('a pnpm + turbo monorepo installs at the root and previews apps/web', () => {
    const config = detect({
      'apps/api/package.json': pkg({
        dependencies: { '@nestjs/core': '10' },
        name: 'api',
        scripts: { dev: 'nest start --watch' },
      }),
      'apps/docs/package.json': pkg({ dependencies: { next: '15' }, scripts: { dev: 'next dev' } }),
      'apps/web/package.json': pkg({
        dependencies: { next: '15', react: '19' },
        name: 'web',
        scripts: { dev: 'next dev --turbo' },
      }),
      'package.json': pkg({ name: 'mono', scripts: { dev: 'turbo run dev' } }),
      'packages/ui/package.json': pkg({ dependencies: { react: '19' }, name: '@acme/ui' }),
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "packages/*"\n',
      'turbo.json': '{}',
    });

    expect(config).toMatchObject({
      dev: 'corepack pnpm run dev',
      install: 'corepack pnpm install --config.dangerously-allow-all-builds=true',
      root: 'apps/web',
      stack: { framework: 'nextjs', packageManager: 'pnpm' },
    });
  });

  it('an npm workspaces monorepo previews its Vite client package', () => {
    const config = detect({
      'client/package.json': pkg({ devDependencies: { vite: '5' }, scripts: { dev: 'vite' } }),
      'package-lock.json': '{}',
      'package.json': pkg({ workspaces: ['client', 'server'] }),
      'server/package.json': pkg({
        dependencies: { express: '4' },
        scripts: { dev: 'node index.js' },
      }),
    });

    expect(config).toMatchObject({
      dev: 'npm run dev -- --host 0.0.0.0 --port 3000 --strictPort',
      install: 'npm ci --no-audit --no-fund',
      root: 'client',
    });
  });

  it('a root that names Next but is no app previews the best app folder below, installed there', () => {
    const config = detect({
      'basics/learn-starter/package.json': pkg({
        dependencies: { next: '14' },
        scripts: { dev: 'next dev' },
      }),
      'basics/learn-starter/pages/index.js': 'export default () => null',
      'dashboard/final-example/app/page.tsx': 'x',
      'dashboard/final-example/package.json': pkg({
        dependencies: { next: '14' },
        scripts: { dev: 'next dev' },
      }),
      'package.json': pkg({ dependencies: { next: '14' }, scripts: { start: 'next start' } }),
      'pnpm-lock.yaml': '',
    });

    expect(config).toMatchObject({
      dev: 'npm run dev',
      install: 'cd basics/learn-starter && npm install --no-audit --no-fund',
      root: 'basics/learn-starter',
    });
  });

  it('client and server folders with no root manifest preview the client', () => {
    const config = detect({
      'client/index.html': '<div id=root></div>',
      'client/package-lock.json': '{}',
      'client/package.json': pkg({ devDependencies: { vite: '6' }, scripts: { dev: 'vite' } }),
      'server/package.json': pkg({
        dependencies: { express: '4' },
        scripts: { start: 'node index.js' },
      }),
    });

    expect(config).toMatchObject({
      dev: 'npm run dev -- --host 0.0.0.0 --port 3000 --strictPort',
      install: 'cd client && npm ci --no-audit --no-fund',
      root: 'client',
    });
  });

  it('an Express server with a literal port and no PORT is previewed where it listens', () => {
    const config = detect({
      'index.js': "const app = require('express')();\napp.listen(8080);\n",
      'package.json': pkg({
        dependencies: { express: '4' },
        main: 'index.js',
        scripts: { start: 'node index.js' },
      }),
    });

    expect(config).toMatchObject({
      dev: 'npm run start',
      port: 8080,
      stack: { framework: 'express' },
    });
  });

  it('a server that honours PORT keeps the preview port', () => {
    const config = detect({
      'package.json': pkg({ dependencies: { express: '4' }, scripts: { start: 'node server.js' } }),
      'server.js': 'app.listen(process.env.PORT || 5000)',
    });

    expect(config.port).toBe(3000);
  });

  it('a package with only a main file runs it with node', () => {
    expect(detect({ 'app.js': 'x', 'package.json': pkg({ main: 'app.js' }) }).dev).toBe(
      'node app.js',
    );
  });

  it('a library has nothing to preview but still installs', () => {
    const config = detect({ 'package.json': pkg({ name: 'lib', scripts: { test: 'vitest' } }) });

    expect(config).toMatchObject({
      dev: null,
      install: 'npm install --no-audit --no-fund',
      port: null,
    });
  });

  it('Bun is run through npx, since the sandbox cannot install it globally', () => {
    const config = detect({
      'bun.lockb': '',
      'package.json': pkg({
        dependencies: { hono: '4' },
        scripts: { dev: 'bun run src/index.ts' },
      }),
    });

    expect(config).toMatchObject({ dev: 'npx -y bun@1 run dev', install: 'npx -y bun@1 install' });
  });

  it('the packageManager field wins over the lockfile', () => {
    expect(
      detect({
        'package-lock.json': '{}',
        'package.json': pkg({ packageManager: 'pnpm@9.1.0', scripts: { dev: 'node x.js' } }),
      }).install,
    ).toBe('corepack pnpm install --config.dangerously-allow-all-builds=true');
  });

  it('Django: migrates, then serves on every interface', () => {
    const config = detect({
      'manage.py': 'import django',
      'mysite/settings.py': '',
      'requirements.txt': 'Django==5.0\npsycopg2\n',
    });

    expect(config).toMatchObject({
      dev: '.venv/bin/python manage.py migrate --noinput; .venv/bin/python manage.py runserver 0.0.0.0:3000',
      install: 'python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt',
      stack: { framework: 'django', language: 'python', packageManager: 'pip' },
    });
  });

  it('FastAPI: finds the app object and adds uvicorn when the manifests do not name it', () => {
    const config = detect({
      'app/main.py': 'from fastapi import FastAPI\n\napi = FastAPI()\n',
      'requirements.txt': 'fastapi\n',
    });

    expect(config).toMatchObject({
      dev: '.venv/bin/uvicorn app.main:api --host 0.0.0.0 --port 3000 --reload',
      install:
        'python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt && .venv/bin/pip install -q uvicorn',
      stack: { framework: 'fastapi' },
    });
  });

  it('Flask with Poetry, and Streamlit with a PEP 621 pyproject', () => {
    const flask = detect({
      'app.py': 'from flask import Flask\napp = Flask(__name__)\n',
      'pyproject.toml': '[tool.poetry]\nname = "x"\n[tool.poetry.dependencies]\nflask = "^3"\n',
    });
    expect(flask.dev).toBe('.venv/bin/flask --app app run --host 0.0.0.0 --port 3000 --debug');
    expect(flask.stack.packageManager).toBe('poetry');

    const streamlit = detect({
      'pyproject.toml': '[project]\nname = "x"\ndependencies = ["streamlit>=1.30"]\n',
      'streamlit_app.py': 'import streamlit as st\n',
    });
    expect(streamlit.dev).toBe(
      '.venv/bin/streamlit run streamlit_app.py --server.port 3000 --server.address 0.0.0.0 --server.headless true',
    );
    expect(streamlit.install).toContain('.venv/bin/uv pip install -r pyproject.toml');
  });

  it('a plain Python script installs and has no preview', () => {
    expect(detect({ 'main.py': 'print(1)', 'requirements.txt': 'requests\n' })).toMatchObject({
      dev: null,
      port: null,
      stack: { framework: null, language: 'python' },
    });
  });

  it('Go: installs a user-space toolchain and runs the main package', () => {
    const config = detect({
      'cmd/server/main.go': 'package main\nfunc main() { http.ListenAndServe(":8080", nil) }\n',
      'go.mod': 'module x\n\ngo 1.22\n',
    });

    expect(config.dev).toBe('go run ./cmd/server');
    expect(config.port).toBe(8080);
    expect(config.install).toContain('go mod download');
  });

  it('Rust and Deno get their own toolchains', () => {
    expect(detect({ 'Cargo.toml': '[package]', 'src/main.rs': 'fn main() {}' })).toMatchObject({
      dev: 'cargo run',
      stack: { language: 'rust' },
    });
    expect(detect({ 'deno.json': '{"tasks":{"dev":"deno run -A main.ts"}}' }).dev).toBe(
      'deno task dev',
    );
  });

  it('a static site is served by python3, which the sandbox always has', () => {
    expect(detect({ 'index.html': '<h1>hi</h1>', 'style.css': '' })).toMatchObject({
      dev: 'python3 -m http.server 3000 --bind 0.0.0.0',
      install: null,
      stack: { framework: 'static', language: 'html' },
    });
  });

  it('a runtime the sandbox cannot provide is named, with no preview claimed', () => {
    expect(detect({ Gemfile: "gem 'rails'", 'config.ru': '' })).toMatchObject({
      dev: null,
      port: null,
      stack: { framework: 'rails', language: 'ruby' },
    });
  });

  it('collects the variable names an example env file declares, never their values', () => {
    const config = detect({
      '.env.example': 'DATABASE_URL=postgres://secret\n# comment\nexport API_KEY=\n',
      'package.json': pkg({ scripts: { dev: 'node x.js' } }),
    });

    expect(config.env).toEqual(['DATABASE_URL', 'API_KEY']);
  });

  it('never puts an unsafe repository value into a command', () => {
    const config = detect({
      'package.json': pkg({ main: 'x.js; rm -rf /', scripts: { 'dev; curl evil': 'x' } }),
    });

    expect(config.dev).toBeNull();
  });

  it('an empty or unreadable repository is an unknown stack with nothing to run', () => {
    expect(detect({ 'README.md': '# hi' })).toMatchObject({
      dev: null,
      install: null,
      stack: { language: 'unknown' },
    });
    expect(detect({ 'package.json': '{ not json' })).toMatchObject({
      dev: null,
      stack: { language: 'unknown' },
    });
  });
});

describe('literalPort', () => {
  it.each([
    ['app.listen(8080)', 8080],
    ['const port = process.env.PORT || 4000', 4000],
    ['http.ListenAndServe(":9090", nil)', 9090],
    ['app.run(port=5001)', 5001],
    ['app.listen(80)', undefined],
    ['nothing here', undefined],
  ])('%s → %s', (source, port) => {
    expect(literalPort(source)).toBe(port);
  });
});
