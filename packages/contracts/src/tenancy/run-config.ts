import { z } from 'zod';

/**
 * A project's own run profile (spec 047): how its dependencies install, how its dev server starts
 * and where it listens. Detected at import, or set by the agent's `set_run_config` tool. When a
 * project has none, its template's manifest answers instead.
 *
 * Every command is one line. It reaches the sandbox as a line of `/tmp/forge-callback.env`, so a
 * CR, LF or NUL inside it would add a variable of its own choosing to that file.
 */

const ONE_LINE = /^[^\r\n\0]+$/;

const commandSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .regex(ONE_LINE, 'a command must be one line');

/** Relative, POSIX, never climbing; `.` is the workspace root. */
const relativeDirSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(\.|[\w@.+-]+(\/[\w@.+-]+)*)$/, 'a relative directory such as `.` or `apps/web`')
  .refine((dir) => !dir.split('/').includes('..'), 'a directory may not contain `..`');

export const RUN_CONFIG_SOURCES = ['detected', 'agent'] as const;

export const runStackSchema = z.strictObject({
  framework: z.string().trim().min(1).max(40).nullable(),
  language: z.string().trim().min(1).max(40),
  packageManager: z.string().trim().min(1).max(20).nullable(),
});

export type RunStack = z.output<typeof runStackSchema>;

export const runConfigSchema = z
  .strictObject({
    build: z.strictObject({ command: commandSchema, output: relativeDirSchema }).nullable(),
    dev: commandSchema.nullable(),
    /** Names only, from `.env.example` and its kin: the agent's hint, never a value. */
    env: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(100)
      .default([]),
    install: commandSchema.nullable(),
    port: z.int().min(1024).max(65_535).nullable(),
    /** Automatic repair runs in the current failure streak; a `listening` report resets it. */
    repairs: z.int().min(0).default(0),
    root: relativeDirSchema.default('.'),
    source: z.enum(RUN_CONFIG_SOURCES),
    stack: runStackSchema,
  })
  .refine((config) => (config.dev === null) === (config.port === null), {
    message: 'dev and port are declared together, or neither',
  });

export type RunConfig = z.output<typeof runConfigSchema>;

/**
 * What the agent's `set_run_config` tool accepts. `source` and `repairs` belong to the platform,
 * and `stack` is optional because a fix to a command does not change what the project is.
 */
export const runConfigInputSchema = z
  .strictObject({
    build: z.strictObject({ command: commandSchema, output: relativeDirSchema }).nullable(),
    dev: commandSchema.nullable(),
    env: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(100)
      .optional(),
    install: commandSchema.nullable(),
    port: z.int().min(1024).max(65_535).nullable(),
    root: relativeDirSchema.optional(),
    stack: runStackSchema.optional(),
  })
  .refine((config) => (config.dev === null) === (config.port === null), {
    message: 'dev and port are declared together, or neither',
  });

export type RunConfigInput = z.output<typeof runConfigInputSchema>;
