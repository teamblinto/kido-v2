/**
 * What a tool call was, in words a person reads (after t3code's `classifyToolActivity` and
 * `workEntryDisplayLabel`): its kind, a verb in the right tense, the thing it acted on, and — once
 * it ended — what it printed and whether that was a failure.
 *
 * Pure and total over `unknown` input: the stream's `tool.start.input` and `tool.end.output` are
 * whatever the executor sent, so every read here is a guarded one and an unrecognised tool still
 * gets an honest line ("Used {tool}") rather than nothing.
 *
 * Two executors feed this. A cloud run's tools are the broker's (`fs_read`, `fs_edit`, `exec`, …);
 * a subscription run's are the CLI's own (`Agent`, `WebSearch`, `TaskCreate`, …) plus the broker's
 * under their bare names. Both are matched by name, case-insensitively.
 */

export type ToolKind =
  | 'agent'
  | 'command'
  | 'edit'
  | 'list'
  | 'other'
  | 'package'
  | 'preview'
  | 'read'
  | 'search'
  | 'task'
  | 'web';

export type ToolStatus = 'done' | 'failed' | 'running';

const EXACT: Readonly<Record<string, ToolKind>> = {
  agent: 'agent',
  bash: 'command',
  edit: 'edit',
  exec: 'command',
  find: 'search',
  fs_edit: 'edit',
  fs_list: 'list',
  fs_read: 'read',
  glob: 'search',
  grep: 'search',
  ls: 'list',
  multiedit: 'edit',
  notebookedit: 'edit',
  preview_logs: 'preview',
  preview_status: 'preview',
  read: 'read',
  search: 'search',
  set_run_config: 'command',
  shell: 'command',
  task: 'agent',
  taskcreate: 'task',
  taskget: 'task',
  tasklist: 'task',
  taskupdate: 'task',
  todowrite: 'task',
  webfetch: 'web',
  websearch: 'web',
  write: 'edit',
};

/** The tool's bare, lower-cased name: an MCP-bridged `mcp__server__fs_read` is `fs_read`. */
function bare(tool: string): string {
  return tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').toLowerCase();
}

/** The tool's kind, from its name. Anything unrecognised is `other`, never a guess at a command. */
export function classifyTool(tool: string): ToolKind {
  const name = bare(tool);
  const exact = EXACT[name];

  if (exact !== undefined) return exact;
  if (name.includes('install') || name.includes('package') || name.startsWith('pkg')) {
    return 'package';
  }
  if (name.includes('edit') || name.includes('write') || name.includes('file')) return 'edit';
  if (/\b(run|bash|exec|shell|terminal)\b/.test(name)) return 'command';

  return 'other';
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];

  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** The first of `keys` the input carries as a non-empty string. */
function first(input: unknown, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = field(input, key);
    if (value !== undefined) return value;
  }

  return undefined;
}

/** A command as one line: `bash -lc "…"` unwrapped, the first line only. */
export function commandText(command: string): string {
  const unwrapped = /^(?:ba)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim())?.[2] ?? command;

  return unwrapped.trim().split('\n')[0] ?? '';
}

/** The program a command runs, for a short label: `pnpm install --frozen` → `pnpm`. */
function program(command: string): string {
  const words = commandText(command).split(/\s+/);
  const skip = new Set(['sudo', 'env', 'npx', 'cd']);
  const word = words.find((candidate) => !skip.has(candidate) && !candidate.includes('='));

  return word ?? 'command';
}

/** One tool call, as a line: a verb in the tense its status calls for, and what it acted on. */
export interface ToolLine {
  readonly kind: ToolKind;
  /** Rendered in mono after the verb: a path, a command, a query. */
  readonly target?: string;
  readonly verb: string;
}

/** Present while it runs, past once it ended (failed included: the glyph says how it ended). */
function tense(status: ToolStatus, live: string, past: string): string {
  return status === 'running' ? live : past;
}

export function describeTool(tool: string, input: unknown, status: ToolStatus): ToolLine {
  const kind = classifyTool(tool);
  const name = bare(tool);
  const path = first(input, 'path', 'file_path', 'filePath', 'notebook_path');
  // A tool whose name was matched loosely (`run pnpm test`, `pkg.add recharts`) and whose input
  // names nothing still shows its own name: it says more than a bare "Ran a command".
  const fallback = EXACT[name] === undefined ? tool : undefined;
  const line = (verb: string, target?: string): ToolLine => {
    const shown = target ?? fallback;

    return shown === undefined ? { kind, verb } : { kind, target: shown, verb };
  };

  switch (kind) {
    case 'read': {
      return line(tense(status, 'Reading', 'Read'), path);
    }

    case 'list': {
      return line(tense(status, 'Listing', 'Listed'), path ?? '/');
    }

    case 'edit': {
      // A whole-file write creates or replaces; an anchored edit changes part of a file.
      const writes = field(input, 'content') !== undefined || name === 'write';

      return writes
        ? line(tense(status, 'Writing', 'Wrote'), path)
        : line(tense(status, 'Editing', 'Edited'), path);
    }

    case 'command': {
      if (name === 'set_run_config') {
        return line(
          tense(status, 'Setting the run command', 'Set the run command'),
          first(input, 'command', 'run'),
        );
      }

      const command = first(input, 'command', 'cmd');

      return command === undefined
        ? line(tense(status, 'Running a command', 'Ran a command'))
        : line(
            tense(status, `Running ${program(command)}`, `Ran ${program(command)}`),
            commandText(command),
          );
    }

    case 'search': {
      const glob = first(input, 'glob', 'pattern');
      const text = first(input, 'text', 'query', 'pattern', 'regex');

      if (name === 'find' || name === 'glob') {
        return line(tense(status, 'Finding files', 'Found files'), glob);
      }

      const where = path === undefined ? '' : ` in ${path}`;

      return line(
        tense(status, 'Searching for', 'Searched for'),
        text === undefined ? undefined : `"${text}"${where}`,
      );
    }

    case 'preview': {
      return name === 'preview_logs'
        ? line(tense(status, 'Reading the preview logs', 'Read the preview logs'))
        : line(tense(status, 'Checking the preview', 'Checked the preview'));
    }

    case 'agent': {
      return line(
        tense(status, 'Delegating to a subagent', 'Delegated to a subagent'),
        first(input, 'description', 'subagent_type', 'prompt'),
      );
    }

    case 'web': {
      return name === 'webfetch'
        ? line(tense(status, 'Fetching', 'Fetched'), first(input, 'url'))
        : line(
            tense(status, 'Searching the web for', 'Searched the web for'),
            first(input, 'query'),
          );
    }

    case 'task': {
      return line(
        tense(status, 'Updating the task list', 'Updated the task list'),
        first(input, 'subject', 'title', 'content', 'description'),
      );
    }

    case 'package': {
      return line(
        tense(status, 'Installing', 'Installed'),
        first(input, 'name', 'package', 'packages'),
      );
    }

    case 'other': {
      return line(tense(status, 'Using', 'Used'), tool);
    }
  }
}

/** What a finished tool printed, as text, and the exit code a command reported, when it did. */
export interface ToolOutput {
  readonly exitCode?: number;
  /** Whether the output itself says the call failed (a subscription tool's `{ ok: false }`). */
  readonly failed: boolean;
  readonly text: string;
}

/**
 * `tool.end.output`, read. A cloud `exec` prints `exit N` on its first line; a subscription tool's
 * output is `{ ok, summary }`, with `ok: false` for a failure its `tool.end` still marks `ok`.
 */
export function readOutput(output: unknown): ToolOutput {
  if (output === undefined || output === null) return { failed: false, text: '' };

  if (typeof output === 'string') {
    const exit = /^exit (-?\d+)(?:\r?\n|$)/.exec(output);

    if (exit !== null) {
      const exitCode = Number(exit[1]);

      return { exitCode, failed: exitCode !== 0, text: output.slice(exit[0].length) };
    }

    return { failed: false, text: output };
  }

  if (typeof output === 'object') {
    const record = output as Record<string, unknown>;
    const summary = typeof record.summary === 'string' ? record.summary : undefined;

    if (summary !== undefined) return { failed: record.ok === false, text: summary };
  }

  try {
    return { failed: false, text: JSON.stringify(output, null, 2) };
  } catch {
    return { failed: false, text: '(output could not be shown)' };
  }
}

/** `+added −removed` for a unified diff: changed lines, the `+++`/`---` file headers excluded. */
export function diffStat(diff: string): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }

  return { added, removed };
}

/** The path a call acted on, when its input names one: what a `file.patch` is matched against. */
export function toolPath(input: unknown): string | undefined {
  return first(input, 'path', 'file_path', 'filePath');
}

/** A subagent's brief, in full, for its expanded card. */
export function agentPrompt(input: unknown): string | undefined {
  return first(input, 'prompt');
}
