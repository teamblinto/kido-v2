import {
  PROJECT_TEMPLATES,
  type ProjectTemplate,
  type RunConfig,
  runConfigSchema,
} from '@repo/contracts';

import type { TemplateCatalogue } from './template-catalogue';

/**
 * How a project runs (spec 047): its own run profile when it has one, its template's manifest
 * otherwise. The one reading every consumer of `devPort`/`devCommand` makes — route broker,
 * preview reader, callback controller, sandbox service, sandbox ops and the deploy build — so a
 * template project resolves exactly as it did before run profiles existed.
 */
export interface DevServer {
  readonly command: string;
  /** Digits, as the manifest declares it and as the env file carries it. */
  readonly port: string;
  /** Runs at the workspace root before the dev server, re-run when the manifests change. */
  readonly install?: string;
  /** The directory the dev server runs in, relative to the workspace root. */
  readonly root?: string;
  /** A run profile rather than a template: the supervisor sets up its runtime (port, host, PATH). */
  readonly profile?: true;
}

export interface ProjectRunSource {
  readonly template: string | null;
  /** `projects.run_config` as stored: unknown until parsed, because a column is not a contract. */
  readonly runConfig: unknown;
}

/** The stored run profile, or null when there is none or it no longer parses. */
export function parseRunConfig(raw: unknown): RunConfig | null {
  if (raw === null || raw === undefined) return null;
  const parsed = runConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function manifestOf(catalogue: TemplateCatalogue, template: string | null) {
  if (template === null || !(PROJECT_TEMPLATES as readonly string[]).includes(template)) {
    return undefined;
  }
  return catalogue.get(template as ProjectTemplate).manifest;
}

/**
 * The dev server a project declares, or `undefined` when it declares none (a library, a script,
 * the `python` template). A run profile that exists decides alone, even when its `dev` is null:
 * falling back to the template there would start a starter app the repository does not contain.
 */
export function resolveDevServer(
  catalogue: TemplateCatalogue,
  source: ProjectRunSource,
): DevServer | undefined {
  const config = parseRunConfig(source.runConfig);

  if (config !== null) {
    if (config.dev === null || config.port === null) return undefined;
    return {
      command: config.dev,
      port: String(config.port),
      profile: true,
      ...(config.install === null ? {} : { install: config.install }),
      ...(config.root === '.' ? {} : { root: config.root }),
    };
  }

  const manifest = manifestOf(catalogue, source.template);
  return manifest?.devCommand === undefined || manifest.devPort === undefined
    ? undefined
    : { command: manifest.devCommand, port: manifest.devPort };
}

/**
 * The preview port alone, as routing and reports compare against: the run profile's `port`, or the
 * manifest's `devPort` — read on its own, exactly as every reader did before run profiles.
 */
export function resolveDevPort(
  catalogue: TemplateCatalogue,
  source: ProjectRunSource,
): number | undefined {
  const config = parseRunConfig(source.runConfig);
  if (config !== null) return config.port ?? undefined;
  const declared = manifestOf(catalogue, source.template)?.devPort;
  return declared === undefined ? undefined : Number(declared);
}

/** What a static deploy runs: the run profile's `build` when it has one, the manifest's otherwise. */
export function resolveBuild(
  catalogue: TemplateCatalogue,
  source: ProjectRunSource,
): { readonly command: string; readonly output: string } | undefined {
  const config = parseRunConfig(source.runConfig);
  if (config !== null) return config.build ?? undefined;
  return manifestOf(catalogue, source.template)?.build;
}
