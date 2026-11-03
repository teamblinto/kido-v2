import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PROJECT_TEMPLATES, type ProjectTemplate } from '@repo/contracts';
import { z } from 'zod';

import type { Environment } from '../../config/environment';

import { SHELL_OPERATOR } from './sandbox-guards';
import { snapshotName, templateDigest } from './template-digest';

/**
 * The template definitions shipped beside `src/` (spec 015, research R2, contract § 1): one
 * directory per `PROJECT_TEMPLATES` id holding a `template.json` manifest and a `files/` scaffold.
 * Loaded once at construction with sync `fs` (a few KB) — a wrong directory set refuses boot.
 */

/** Daytona refuses floating tags; a build must start from a pinned base. */
const FLOATING_TAGS = new Set(['latest', 'lts', 'stable']);

const tagOf = (base: string): string | undefined => {
  const last = base.slice(base.lastIndexOf('/') + 1);
  const colon = last.indexOf(':');
  return colon === -1 ? undefined : last.slice(colon + 1);
};

/**
 * How a template says it is deployable (spec 027, research R4): one program with arguments, run in
 * the project root, and the relative directory it leaves the static site in. `command` carries no
 * shell operator (the same rule as `checkCommand`); `output` is relative and never climbs.
 */
const buildSchema = z.strictObject({
  command: z
    .string()
    .trim()
    .min(1)
    .refine((command) => !SHELL_OPERATOR.test(command), {
      message: 'build.command must be one program with arguments, no shell operators',
    }),
  output: z
    .string()
    .min(1)
    .refine(
      (output) =>
        !output.includes('\\') &&
        !output.includes('\0') &&
        !path.posix.isAbsolute(output) &&
        !/^[A-Za-z]:/.test(output) &&
        !output.split('/').includes('..'),
      { message: 'build.output must be a relative directory with no ..' },
    ),
});

export const manifestSchema = z
  .strictObject({
    base: z
      .string()
      .min(1)
      .refine((base) => !FLOATING_TAGS.has(tagOf(base) ?? ''), {
        message: 'base must carry an explicit tag, not latest, lts or stable',
      }),
    /** Spec 027 research R4: what a deploy runs; excluded from `templateDigest` — see `loadOne`. */
    build: buildSchema.optional(),
    description: z.string().min(1).max(200),
    /** What starts the dev server (research R3); excluded from `templateDigest` — see `loadOne`. */
    devCommand: z.string().trim().min(1).optional(),
    /** The dev server's port (research R9); excluded from `templateDigest` — see `loadOne`. */
    devPort: z
      .string()
      .regex(/^\d+$/, 'devPort must be digits')
      .refine((port) => Number(port) >= 1024 && Number(port) <= 65535, {
        message: 'devPort must be 1024-65535',
      })
      .optional(),
    install: z.string().min(1),
    /**
     * Spec 041: run `install` detached in a daemon session and poll for its exit, for an install
     * that outlasts one HTTP exchange. How it runs, not what it builds: excluded from the digest.
     */
    installInSession: z.boolean().optional(),
    name: z.string().min(1).max(60),
  })
  // Half a declaration is a dev server nobody can start or reach: refused when the catalogue is
  // read, which is boot, where spec 015 puts every other manifest refusal (FR-003).
  .refine((manifest) => (manifest.devCommand === undefined) === (manifest.devPort === undefined), {
    message: 'devCommand and devPort must both be declared, or neither',
  });

export type TemplateManifest = z.output<typeof manifestSchema>;

/**
 * Images published through the same path as the project templates (so they work on a VM-class
 * fleet too) that are never offered to a project: not in the catalogue's `all()`, the pool, or
 * the templates route. Spec 041's agent home is the one. Optional on disk, so a fixture directory
 * of project templates alone still loads.
 */
export const SYSTEM_TEMPLATES = ['agent-home'] as const;

export type SystemTemplate = (typeof SYSTEM_TEMPLATES)[number];

/** Anything the publisher can build: a project template or a system one. */
export type CatalogueTemplate = ProjectTemplate | SystemTemplate;

/** In a manifest's `install`, filled with `AGENT_HOME_CLAUDE_VERSION` before the digest is taken. */
const CLAUDE_VERSION_PLACEHOLDER = '{{AGENT_HOME_CLAUDE_VERSION}}';

export interface TemplateFile {
  /** POSIX-separated, relative to `files/`. */
  readonly path: string;
  /** CRLF → LF. */
  readonly content: Buffer;
}

export interface TemplateDefinition {
  readonly id: CatalogueTemplate;
  readonly manifest: TemplateManifest;
  /** Sorted by `path`. */
  readonly files: readonly TemplateFile[];
  /** 64 hex, `templateDigest(manifest, files)`. */
  readonly digest: string;
  /** `forge-tpl-<id>-<12 hex>`. */
  readonly snapshot: string;
}

/** A definition the catalogue offers projects: never a system template. */
export type ProjectTemplateDefinition = TemplateDefinition & { readonly id: ProjectTemplate };

/** `apps/api/templates`: same depth from `src/modules/sandbox/` and `dist/modules/sandbox/` (research R2 says `../../`, which lands in `src/templates` — three levels is the real depth). */
export const DEFAULT_TEMPLATES_DIR = path.join(__dirname, '../../../templates');

/** The injection token the module binds to `DEFAULT_TEMPLATES_DIR`; specs point it at a fixture. */
export const TEMPLATES_DIR = Symbol('forge.sandbox.templatesDir');

// ponytail: byte-level CRLF → LF on the whole buffer; the scaffolds are text, a binary carrying
// 0x0D 0x0A would be altered — add a binary sniff if a template ever ships one.
const normaliseLf = (buf: Buffer): Buffer =>
  buf.includes('\r\n') ? Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : buf;

const walk = (root: string, rel: string, out: TemplateFile[]): void => {
  const dir = path.join(root, rel);
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) throw new Error(`template files: empty directory ${dir}`);
  for (const entry of entries) {
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isSymbolicLink())
      throw new Error(`template files: symlink ${path.join(dir, entry.name)}`);
    if (entry.isDirectory()) walk(root, relPath, out);
    else if (entry.isFile())
      out.push({ content: normaliseLf(readFileSync(path.join(dir, entry.name))), path: relPath });
    else throw new Error(`template files: not a plain file ${path.join(dir, entry.name)}`);
  }
};

const loadOne = (dir: string, id: CatalogueTemplate, claudeVersion: string): TemplateDefinition => {
  const root = path.join(dir, id);
  const raw = JSON.parse(readFileSync(path.join(root, 'template.json'), 'utf8')) as {
    install?: unknown;
  };
  // The pinned CLI version is part of the image, so it is part of the digest: a new version is a
  // new snapshot name on the next publish.
  if (typeof raw.install === 'string') {
    raw.install = raw.install.replaceAll(CLAUDE_VERSION_PLACEHOLDER, claudeVersion);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`template ${id}: bad manifest — ${parsed.error.message}`);
  const files: TemplateFile[] = [];
  walk(path.join(root, 'files'), '', files);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  // devPort and devCommand are routing and run details (research R9, R3), and build is what a
  // deploy runs (spec 027 research R4) — none is part of the built image: excluded here so adding
  // or changing any of them rotates no digest and no snapshot name.
  const { base, description, install, name } = parsed.data;
  const digest = templateDigest({ base, description, install, name }, files);
  return { digest, files, id, manifest: parsed.data, snapshot: snapshotName(id, digest) };
};

@Injectable()
export class TemplateCatalogue {
  private readonly byId: ReadonlyMap<ProjectTemplate, ProjectTemplateDefinition>;
  private readonly system: ReadonlyMap<SystemTemplate, TemplateDefinition>;

  constructor(
    @Optional() @Inject(TEMPLATES_DIR) dir: string = DEFAULT_TEMPLATES_DIR,
    @Optional() @Inject(ConfigService) config?: ConfigService<Environment, true>,
  ) {
    const claudeVersion = config?.get('AGENT_HOME_CLAUDE_VERSION', { infer: true }) ?? 'stable';
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
    const isSystem = (name: string): name is SystemTemplate =>
      (SYSTEM_TEMPLATES as readonly string[]).includes(name);
    const found = dirs.filter((name) => !isSystem(name)).sort();
    const expected = [...PROJECT_TEMPLATES].sort();
    if (found.join(',') !== expected.join(',')) {
      throw new Error(
        `templates dir ${dir}: expected [${expected.join(', ')}], found [${found.join(', ')}]`,
      );
    }
    this.byId = new Map(
      PROJECT_TEMPLATES.map((id) => [
        id,
        loadOne(dir, id, claudeVersion) as ProjectTemplateDefinition,
      ]),
    );
    this.system = new Map(
      dirs.filter(isSystem).map((id) => [id, loadOne(dir, id, claudeVersion)] as const),
    );
  }

  get(id: CatalogueTemplate): TemplateDefinition {
    const definition =
      this.byId.get(id as ProjectTemplate) ?? this.system.get(id as SystemTemplate);
    if (!definition) throw new Error(`unknown template ${id}`);
    return definition;
  }

  /** `PROJECT_TEMPLATES` order; never a system template. */
  all(): readonly ProjectTemplateDefinition[] {
    return [...this.byId.values()];
  }
}
