import { z } from 'zod';

import type {
  ContentMatch,
  ExecResult,
  FileEntry,
  MutationContext,
  PreviewStatus,
  SandboxPort,
  SandboxRef,
} from '../sandbox/sandbox.port';

/** Wire name of one of the seven tools the model may call (contracts/tool-broker.md). */
export type ToolName =
  'fs_read' | 'fs_list' | 'fs_edit' | 'exec' | 'search' | 'find' | 'preview_status';

/** What a tool call answers with, before the broker turns it into a `BrokerResult`. */
export interface ToolOutcome {
  readonly output: string;
  /** Set only for `fs_edit` when the diff is non-empty. */
  readonly patch?: { readonly path: string; readonly diff: string };
}

/** One tool offered to the model: its schema, description and port call. */
export interface ToolSpec<I = unknown> {
  readonly name: ToolName;
  readonly description: string;
  readonly input: z.ZodType<I>;
  readonly call: (
    port: SandboxPort,
    ref: SandboxRef,
    input: I,
    ctx: MutationContext,
  ) => Promise<ToolOutcome>;
}

const fsReadInput = z.strictObject({ path: z.string() });

const fsListInput = z.strictObject({ path: z.string() });

const fsEditInput = z.union([
  z.strictObject({ content: z.string(), path: z.string() }),
  z.strictObject({ path: z.string(), replace: z.string(), search: z.string() }),
]);

const execInput = z.strictObject({ command: z.string() });

const searchInput = z.strictObject({ path: z.string().optional(), text: z.string() });

const findInput = z.strictObject({ glob: z.string(), path: z.string().optional() });

/** No input: the tool is addressed by `(orgId, projectId)` like every other, and there is one port. */
const previewStatusInput = z.strictObject({});

function formatEntry(entry: FileEntry): string {
  return `${entry.kind}\t${entry.name}\t${entry.size}`;
}

function formatExec(result: ExecResult): string {
  if (result.timedOut) return 'timed out after 120 s';
  const suffix = result.truncated ? '\n[output truncated]' : '';
  return `exit ${result.exitCode}\n${result.output}${suffix}`;
}

function formatMatch(match: ContentMatch): string {
  return `${match.path}:${match.line}: ${match.text}`;
}

/**
 * One line, and the whole answer (contracts/preview-status-tool.md § 3). "Nothing observed yet" is
 * an answer, not a failure (FR-021), and no provider id, node, internal address or preview label
 * appears in any of the three — a tool answer is model-visible text (FR-024).
 */
function formatPreview(status: PreviewStatus): string {
  if (status.port === null) return 'this project has no preview port';
  if (status.observed === null) return `port ${status.port}: not observed yet`;
  return `port ${status.port}: ${status.observed.state} (observed ${status.observed.at})`;
}

/** Erases `I` to `unknown` so a `ToolSpec<I>` fits in the fixed-order array below. */
function widen<I>(spec: ToolSpec<I>): ToolSpec {
  return spec as ToolSpec;
}

export const TOOLS: readonly ToolSpec[] = Object.freeze([
  widen({
    call: async (port, ref, input: z.output<typeof fsReadInput>, ctx) => ({
      output: await port.read(ref, input.path, ctx),
    }),
    description:
      'Read a whole file as UTF-8. Jailed to the workspace root; refuses a file over 2 MiB, a directory, or a missing path.',
    input: fsReadInput,
    name: 'fs_read',
  }),
  widen({
    call: async (port, ref, input: z.output<typeof fsListInput>, ctx) => ({
      output: (await port.list(ref, input.path, ctx)).map(formatEntry).join('\n'),
    }),
    description:
      "List a directory's direct children, name-sorted. Jailed to the workspace root; a symlink is listed, never followed.",
    input: fsListInput,
    name: 'fs_list',
  }),
  widen({
    call: async (port, ref, input: z.output<typeof fsEditInput>, ctx) => {
      const result = await port.edit(ref, input, ctx);
      if (result.diff === '') return { output: 'no change' };
      return { output: result.diff, patch: { diff: result.diff, path: input.path } };
    },
    description:
      'Write a whole file, or replace one anchored, single-match occurrence. Jailed to the workspace root; an anchor must match exactly once.',
    input: fsEditInput,
    name: 'fs_edit',
  }),
  widen({
    call: async (port, ref, input: z.output<typeof execInput>, ctx) => ({
      output: formatExec(await port.exec(ref, input.command, ctx)),
    }),
    description:
      'Run one allowlisted program with a 120 s timeout and a 64 KiB head/tail cap on combined stdout and stderr.',
    input: execInput,
    name: 'exec',
  }),
  widen({
    call: async (port, ref, input: z.output<typeof searchInput>, ctx) => {
      const matches = await port.search(ref, { path: input.path, text: input.text }, ctx);
      return { output: matches.length === 0 ? 'no matches' : matches.map(formatMatch).join('\n') };
    },
    description:
      'Search file contents for a substring under the workspace root (or a given path), capped, vendor paths excluded.',
    input: searchInput,
    name: 'search',
  }),
  widen({
    call: async (port, ref, input: z.output<typeof findInput>, ctx) => {
      const paths = await port.find(ref, { glob: input.glob, path: input.path }, ctx);
      return { output: paths.length === 0 ? 'no matches' : paths.join('\n') };
    },
    description:
      'Find files by base-name glob under the workspace root (or a given path), capped, vendor paths excluded.',
    input: findInput,
    name: 'find',
  }),
  widen({
    call: async (port, ref, _input: z.output<typeof previewStatusInput>, ctx) => ({
      output: formatPreview(await port.previewStatus(ref, ctx)),
    }),
    description:
      "Report whether this project's preview is serving. Answers the declared port and the last state its sandbox observed — starting, listening or failed — with the time it was observed. Reports only; it never starts, restarts or stops anything.",
    input: previewStatusInput,
    name: 'preview_status',
  }),
]);
