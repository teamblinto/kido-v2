import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PROJECT_TEMPLATES } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TEMPLATES_DIR,
  manifestSchema,
  TemplateCatalogue,
  type TemplateDefinition,
} from './template-catalogue';

const FIXTURES = path.join(__dirname, '../../../test/fixtures/templates');
const fixture = (name: string) => path.join(FIXTURES, name);

describe('manifestSchema', () => {
  const good = {
    base: 'daytonaio/sandbox:0.5.0-slim',
    description: 'd',
    install: 'npm ci',
    name: 'n',
  };

  it('accepts a pinned base', () => {
    expect(manifestSchema.parse(good)).toEqual(good);
  });

  it.each(['node:latest', 'node:lts', 'ghcr.io/org/img:stable'])('refuses %s', (base) => {
    expect(manifestSchema.safeParse({ ...good, base }).success).toBe(false);
  });

  it('accepts a registry port with a pinned tag and refuses unknown keys', () => {
    expect(manifestSchema.safeParse({ ...good, base: 'localhost:5000/img:1.2' }).success).toBe(
      true,
    );
    expect(manifestSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });

  it('accepts devPort at the 1024-65535 bound and refuses outside it', () => {
    // Paired with a devCommand throughout, so the bound is the only thing left to refuse it.
    const dev = (devPort: string) => ({ ...good, devCommand: 'npm run dev', devPort });

    expect(manifestSchema.safeParse(good).success).toBe(true); // devPort is optional
    expect(manifestSchema.safeParse(dev('1024')).success).toBe(true);
    expect(manifestSchema.safeParse(dev('65535')).success).toBe(true);
    expect(manifestSchema.safeParse(dev('1023')).success).toBe(false);
    expect(manifestSchema.safeParse(dev('65536')).success).toBe(false);
    expect(manifestSchema.safeParse(dev('abc')).success).toBe(false);
  });

  it('accepts devCommand beside devPort, and refuses a blank one', () => {
    expect(
      manifestSchema.safeParse({ ...good, devCommand: 'npm run dev', devPort: '3000' }).success,
    ).toBe(true);
    expect(manifestSchema.safeParse({ ...good, devCommand: '   ', devPort: '3000' }).success).toBe(
      false,
    );
  });

  it('refuses devCommand without devPort, and devPort without devCommand (FR-003)', () => {
    expect(manifestSchema.safeParse({ ...good, devPort: '3000' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...good, devCommand: 'npm run dev' }).success).toBe(false);
    expect(manifestSchema.safeParse(good).success).toBe(true); // both absent is a whole answer
  });

  describe('build (027 research R4)', () => {
    const build = { command: 'npm run build', output: 'dist' };
    const withBuild = (b: Record<string, unknown>) =>
      manifestSchema.safeParse({ ...good, build: b });

    it('is optional, and accepted whole', () => {
      expect(manifestSchema.parse(good).build).toBeUndefined();
      expect(manifestSchema.parse({ ...good, build }).build).toEqual(build);
      expect(withBuild({ command: 'npm run build', output: 'out/web' }).success).toBe(true);
    });

    it('refuses half a declaration, a blank field and unknown keys', () => {
      expect(withBuild({ command: 'npm run build' }).success).toBe(false);
      expect(withBuild({ output: 'dist' }).success).toBe(false);
      expect(withBuild({ ...build, command: '  ' }).success).toBe(false);
      expect(withBuild({ ...build, output: '' }).success).toBe(false);
      expect(withBuild({ ...build, extra: 1 }).success).toBe(false);
    });

    it.each([
      'npm run build && rm -rf /',
      'npm run build; echo x',
      'npm run build | tee log',
      'npm run build > log',
      'npm run build `id`',
      'npm run $(id)',
      'npm run build\necho x',
    ])('refuses a command with a shell operator: %j', (command) => {
      expect(withBuild({ ...build, command }).success).toBe(false);
    });

    it.each([
      '/dist',
      '../dist',
      'out/../../etc',
      '..',
      'C:\\dist',
      '\\\\host\\share',
      'out\\..\\x',
      'C:dist',
      'di\0st',
    ])('refuses an output that is absolute or climbs: %j', (output) => {
      expect(withBuild({ ...build, output }).success).toBe(false);
    });
  });
});

describe('TemplateCatalogue', () => {
  const temps: string[] = [];
  /** A writable copy of the good fixture set, for the cases git cannot store. */
  const scratch = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-tpl-'));
    cpSync(fixture('good'), dir, { recursive: true });
    temps.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { force: true, recursive: true });
  });

  it('loads the four definitions in PROJECT_TEMPLATES order with sorted, LF-normalised files', () => {
    const catalogue = new TemplateCatalogue(fixture('good'));

    expect(catalogue.all().map((t) => t.id)).toEqual([...PROJECT_TEMPLATES]);
    const vite = catalogue.get('vite-react');
    expect(vite.manifest.name).toBe('Good vite-react');
    expect(vite.files.map((f) => f.path)).toEqual(['index.js', 'src/nested.txt', 'zzz.txt']);
    expect(vite.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(vite.snapshot).toBe(`forge-tpl-vite-react-${vite.digest.slice(0, 12)}`);
    expect(catalogue.get('python').digest).not.toBe(vite.digest);
  });

  it('normalises CRLF to LF', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'python/files/crlf.txt'), 'a\r\nb\r\n');

    const file = new TemplateCatalogue(dir).get('python').files.find((f) => f.path === 'crlf.txt');
    expect(file?.content.toString()).toBe('a\nb\n');
  });

  it('refuses a missing or extra directory', () => {
    expect(() => new TemplateCatalogue(fixture('missing'))).toThrow(/expected \[.*\], found \[/);
    expect(() => new TemplateCatalogue(fixture('extra'))).toThrow(/rust/);
  });

  it('refuses a bad manifest', () => {
    expect(() => new TemplateCatalogue(fixture('bad-manifest'))).toThrow(
      /template python: bad manifest/,
    );
  });

  it('refuses a half-declared dev server, and loads one declared whole or not at all (FR-003)', () => {
    const declaring = (dev: Record<string, string>): string => {
      const dir = scratch();
      const manifestPath = path.join(dir, 'nextjs/template.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, ...dev }));
      return dir;
    };

    expect(() => new TemplateCatalogue(declaring({ devPort: '3000' }))).toThrow(
      /template nextjs: bad manifest/,
    );
    expect(() => new TemplateCatalogue(declaring({ devCommand: 'npm run dev' }))).toThrow(
      /template nextjs: bad manifest/,
    );
    expect(
      new TemplateCatalogue(declaring({ devCommand: 'npm run dev', devPort: '3000' })).get('nextjs')
        .manifest.devCommand,
    ).toBe('npm run dev');
    // The fixtures declare neither, and load: a template without a dev server is not half a one.
    expect(new TemplateCatalogue(fixture('good')).get('nextjs').manifest.devPort).toBeUndefined();
  });

  it('refuses an empty files/ and an empty directory inside it', () => {
    const empty = scratch();
    rmSync(path.join(empty, 'nextjs/files'), { recursive: true });
    mkdirSync(path.join(empty, 'nextjs/files'));
    expect(() => new TemplateCatalogue(empty)).toThrow(/empty directory/);

    const nested = scratch();
    mkdirSync(path.join(nested, 'node-api/files/hollow'));
    expect(() => new TemplateCatalogue(nested)).toThrow(/empty directory.*hollow/);
  });

  it('refuses a symlink inside files/', () => {
    const dir = scratch();
    try {
      symlinkSync(path.join(dir, 'python/files/index.js'), path.join(dir, 'python/files/link.js'));
    } catch {
      return; // Windows without symlink privilege: nothing to prove here.
    }
    expect(() => new TemplateCatalogue(dir)).toThrow(/symlink/);
  });

  it('excludes devPort and devCommand from the digest (research R9, R3)', () => {
    const withoutDev = new TemplateCatalogue(fixture('good')).get('python').digest;

    const dir = scratch();
    const manifestPath = path.join(dir, 'python/template.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, devCommand: 'npm run dev', devPort: '3000' }),
    );
    const withDev = new TemplateCatalogue(dir).get('python').digest;

    expect(withDev).toBe(withoutDev);
  });

  it('refuses a manifest with a bad build at boot (027 research R4)', () => {
    const dir = scratch();
    const manifestPath = path.join(dir, 'vite-react/template.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        build: { command: 'npm run build && curl x', output: 'dist' },
      }),
    );

    expect(() => new TemplateCatalogue(dir)).toThrow(/template vite-react: bad manifest/);
  });

  it('excludes build from the digest (027 research R4)', () => {
    const withoutBuild = new TemplateCatalogue(fixture('good')).get('vite-react');

    const dir = scratch();
    const manifestPath = path.join(dir, 'vite-react/template.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, build: { command: 'npm run build', output: 'dist' } }),
    );
    const withBuild = new TemplateCatalogue(dir).get('vite-react');

    expect(withBuild.manifest.build).toEqual({ command: 'npm run build', output: 'dist' });
    expect(withBuild.digest).toBe(withoutBuild.digest);
    expect(withBuild.snapshot).toBe(withoutBuild.snapshot);
  });

  it('refuses an unknown id', () => {
    expect(() => new TemplateCatalogue(fixture('good')).get('rust' as never)).toThrow(
      /unknown template/,
    );
  });

  // T005 authors the real definitions; until they land this case fails by design.
  it('loads the real apps/api/templates/ set', () => {
    const catalogue = new TemplateCatalogue(DEFAULT_TEMPLATES_DIR);

    expect(catalogue.all().map((t) => t.id)).toEqual([
      'vite-react',
      'nextjs',
      'node-api',
      'python',
    ]);
    for (const t of catalogue.all()) expect(t.manifest.name).not.toBe('');
  });

  it('pins the agent home to AGENT_HOME_CLAUDE_VERSION: a new version is a new snapshot (041)', () => {
    const at = (version: string) =>
      new TemplateCatalogue(DEFAULT_TEMPLATES_DIR, {
        get: () => version,
      } as never).get('agent-home');

    expect(at('2.1.3').manifest.install).toBe('bash install.sh 2.1.3');
    expect(at('2.1.3').snapshot).not.toBe(at('2.1.4').snapshot);
    expect(at('2.1.3').digest).toBe(at('2.1.3').digest);
  });

  it('declares a build on vite-react only (027 research R4)', () => {
    const catalogue = new TemplateCatalogue(DEFAULT_TEMPLATES_DIR);

    expect(catalogue.all().map((t) => [t.id, t.manifest.build ?? null])).toEqual([
      ['vite-react', { command: 'npm run build', output: 'dist' }],
      ['nextjs', null],
      ['node-api', null],
      ['python', null],
    ]);
  });

  it('declares, on each real template, the devPort its own dev script serves (research R4)', () => {
    /**
     * The port a template's dev script actually serves: the `--port` its command line names, or,
     * for a script that only hands an entry file to a runner, that file's own fallback. It throws
     * rather than shrugs — a resolver that returns "cannot tell" would have let vite-react's
     * 5173/3000 drift through exactly as silently as having no case at all did.
     */
    const servedPort = (t: TemplateDefinition): string => {
      const read = (p: string): string => {
        const file = t.files.find((f) => f.path === p);
        if (!file) throw new Error(`${t.id}: ${p} is not in files/`);
        return file.content.toString();
      };

      const run = /^npm run (\S+)$/.exec(t.manifest.devCommand ?? '')?.[1];
      if (run === undefined) throw new Error(`${t.id}: devCommand is not an npm script`);
      const script = (JSON.parse(read('package.json')) as { scripts?: Record<string, string> })
        .scripts?.[run];
      if (script === undefined) throw new Error(`${t.id}: package.json has no ${run} script`);

      const flag = /--port[= ](\d+)/.exec(script)?.[1];
      if (flag !== undefined) return flag;

      const entry = /(\S+\.[cm]?[jt]sx?)\b/.exec(script)?.[1];
      if (entry === undefined)
        throw new Error(`${t.id}: ${run} names neither a port nor an entry file`);
      const fallback = /process\.env\.PORT\s*\?\?\s*(\d+)/.exec(read(entry))?.[1];
      if (fallback === undefined) throw new Error(`${t.id}: ${entry} serves no port this can read`);
      return fallback;
    };

    const catalogue = new TemplateCatalogue(DEFAULT_TEMPLATES_DIR);

    for (const t of catalogue.all()) {
      const pkg = t.files.find((f) => f.path === 'package.json');
      const dev = pkg
        ? (JSON.parse(pkg.content.toString()) as { scripts?: Record<string, string> }).scripts?.dev
        : undefined;

      // A template that can start a dev server declares one; python, which ships no package.json
      // and no way to start anything, declares neither half (FR-003, FR-004). The id rides in the
      // compared value so a failure names the template rather than just a boolean.
      const declares = (has: boolean) => `${t.id}: ${has ? 'dev server' : 'none'}`;
      expect(declares(t.manifest.devCommand !== undefined)).toBe(declares(dev !== undefined));

      if (dev === undefined) continue;
      expect(`${t.id}: ${servedPort(t)}`).toBe(`${t.id}: ${t.manifest.devPort}`);
    }
  });
});
