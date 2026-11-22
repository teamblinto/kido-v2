import type { Attachment, RunEvent, RunResponse } from '@repo/contracts';

import {
  type ToolKind,
  type ToolStatus,
  classifyTool,
  diffStat,
  readOutput,
  toolPath,
} from './tool-activity';
import { type TranscriptItem, joinTokens } from './transcript';

/**
 * The chat's rows, from the transcript (spec 043): the person's messages, the assistant's text as
 * one message per stretch of tokens, consecutive tool calls and file changes as one work group,
 * and the run's other notices as they came. Pure, so the grouping rules are tested without a DOM.
 */

/**
 * Something said outside the run's events: what the person sent, or (`role: 'assistant'`) a reply
 * read back from the record, whose tokens were never stored.
 */
export interface UserTurn {
  /** Where it sits: before the joined transcript item at this index (`Infinity`: at the end). */
  readonly at: number;
  /** Files the person attached (spec 048); absent or empty on a reply. */
  readonly attachments?: readonly Attachment[];
  readonly id: string;
  readonly role?: 'assistant';
  readonly text: string;
}

/** A file change the run reported (`file.patch`), as a unified diff. */
export interface FilePatch {
  readonly diff: string;
  readonly path: string;
}

export type WorkEntry =
  | {
      /** The failure's own words, when the call failed. */
      readonly detail?: string;
      /** A command's exit status, when its output reported one. */
      readonly exitCode?: number;
      readonly id: string;
      /** What the call was given, as the executor sent it. */
      readonly input: unknown;
      readonly kind: 'tool';
      /** What it printed: its `tool.end` output, or the `tool.delta` chunks so far while it runs. */
      readonly output: string;
      /** The changes this call made, matched from the `file.patch` events that followed it. */
      readonly patches: readonly FilePatch[];
      readonly status: ToolStatus;
      /** The tool's own name, verbatim. */
      readonly title: string;
      readonly tool: ToolKind;
    }
  | ({ readonly id: string; readonly kind: 'patch' } & FilePatch)
  /** The model thinking aloud (`thought`), consecutive deltas joined. */
  | { readonly id: string; readonly kind: 'reasoning'; readonly text: string };

export type TimelineRow =
  | { readonly id: string; readonly kind: 'assistant'; readonly text: string }
  | { readonly event: RunEvent; readonly id: string; readonly kind: 'notice' }
  | {
      readonly attachments: readonly Attachment[];
      readonly id: string;
      readonly kind: 'user';
      readonly text: string;
    }
  | { readonly entries: readonly WorkEntry[]; readonly id: string; readonly kind: 'work' };

/** Events with no row of their own; they neither show nor break a work group. */
function isSilent(event: RunEvent): boolean {
  switch (event.type) {
    // `tool.end` is the other half of its `tool.start`, and `tool.delta` is its live output — both
    // are folded into the call's entry. Usage is on the run record. Approvals are history from
    // retired local-agent runs (spec 040).
    case 'approval.request':
    case 'approval.resolved':
    case 'tool.delta':
    case 'tool.end':
    case 'usage': {
      return true;
    }
    case 'state': {
      return event.data.reason === undefined;
    }
    default: {
      return false;
    }
  }
}

export function buildTimeline(
  items: readonly TranscriptItem[],
  turns: readonly UserTurn[] = [],
): TimelineRow[] {
  const joined = joinTokens(items);
  // `tool.end` is matched to the `tool.start` sharing its `stepId`; unpaired means still running.
  // `tool.delta` chunks are the same call's output as it prints, joined in arrival order.
  const ends = new Map<string, Extract<RunEvent, { type: 'tool.end' }>>();
  const deltas = new Map<string, string>();

  for (const { event } of joined) {
    if (event.type === 'tool.end') ends.set(event.data.stepId, event);
    if (event.type === 'tool.delta') {
      deltas.set(event.data.stepId, (deltas.get(event.data.stepId) ?? '') + event.data.chunk);
    }
  }

  const rows: TimelineRow[] = [];
  const pending = [...turns].sort((a, b) => a.at - b.at);
  let work: WorkEntry[] | undefined;

  const flushTurns = (index: number): void => {
    while (pending[0] !== undefined && pending[0].at <= index) {
      const turn = pending.shift();
      if (turn === undefined) break;
      work = undefined;
      rows.push(
        turn.role === 'assistant'
          ? { id: turn.id, kind: 'assistant', text: turn.text }
          : { attachments: turn.attachments ?? [], id: turn.id, kind: 'user', text: turn.text },
      );
    }
  };

  joined.forEach((item, index) => {
    flushTurns(index);
    const { event } = item;

    if (isSilent(event)) return;

    if (event.type === 'tool.start' || event.type === 'file.patch' || event.type === 'thought') {
      if (work === undefined) {
        work = [];
        rows.push({ entries: work, id: item.id, kind: 'work' });
      }

      if (event.type === 'thought') {
        // One reasoning entry per stretch of thinking: deltas arrive a few words at a time, and a
        // row each was a column of fragments (t3code keeps reasoning inside the work log too).
        const last = work.at(-1);

        if (last?.kind === 'reasoning') {
          work[work.length - 1] = { ...last, text: last.text + event.data.text };
        } else {
          work.push({ id: item.id, kind: 'reasoning', text: event.data.text });
        }

        return;
      }

      if (event.type === 'file.patch') {
        // The change an edit just made belongs on that edit's line, not on a second "Changed"
        // line beneath it: matched to the latest call in this group that names the same path.
        const { diff, path } = event.data;
        let owner = -1;

        for (let index = work.length - 1; index >= 0 && owner === -1; index -= 1) {
          const entry = work[index];
          if (entry?.kind === 'tool' && entry.tool === 'edit' && toolPath(entry.input) === path) {
            owner = index;
          }
        }
        const target = work[owner];

        if (target?.kind === 'tool') {
          work[owner] = { ...target, patches: [...target.patches, { diff, path }] };
        } else {
          work.push({ diff, id: item.id, kind: 'patch', path });
        }

        return;
      }

      const end = ends.get(event.data.stepId);
      const read = readOutput(end?.data.output);
      const failed = end !== undefined && (!end.data.ok || read.failed);
      const status: ToolStatus = end === undefined ? 'running' : failed ? 'failed' : 'done';
      const detail =
        end?.data.error ?? (read.failed && read.exitCode === undefined ? read.text : undefined);

      work.push({
        ...(detail === undefined ? {} : { detail }),
        ...(read.exitCode === undefined ? {} : { exitCode: read.exitCode }),
        id: item.id,
        input: event.data.input,
        kind: 'tool',
        output: end === undefined ? (deltas.get(event.data.stepId) ?? '') : read.text,
        patches: [],
        status,
        title: event.data.tool,
        tool: classifyTool(event.data.tool),
      });

      return;
    }

    work = undefined;
    rows.push(
      event.type === 'token'
        ? { id: item.id, kind: 'assistant', text: event.data.text }
        : { event, id: item.id, kind: 'notice' },
    );
  });

  flushTurns(Number.POSITIVE_INFINITY);

  return rows;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * "Read 3 files · edited 2 files · ran 3 commands" — what a work group did, counted from its
 * entries in the order a reader cares about (t3code's `summarizeToolGroup`). Edited files are
 * distinct paths when the run reported its patches, so editing one file twice is one file.
 */
export function workSummary(entries: readonly WorkEntry[]): string {
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const count = (kind: ToolKind) => tools.filter((tool) => tool.tool === kind).length;
  const paths = new Set(
    entries.flatMap((entry) =>
      entry.kind === 'patch'
        ? [entry.path]
        : entry.kind === 'tool'
          ? entry.patches.map((patch) => patch.path)
          : [],
    ),
  );
  const edits = paths.size > 0 ? paths.size : count('edit');
  const reads = new Set(
    tools.filter((tool) => tool.tool === 'read').map((tool) => toolPath(tool.input) ?? tool.id),
  ).size;
  const others = count('other') + count('task') + count('preview') + count('list');
  const parts = [
    reads > 0 ? `read ${plural(reads, 'file', 'files')}` : undefined,
    edits > 0 ? `edited ${plural(edits, 'file', 'files')}` : undefined,
    count('command') > 0 ? `ran ${plural(count('command'), 'command', 'commands')}` : undefined,
    count('search') > 0 ? `searched ${plural(count('search'), 'time', 'times')}` : undefined,
    count('package') > 0
      ? `installed ${plural(count('package'), 'package', 'packages')}`
      : undefined,
    count('web') > 0 ? `searched the web ${plural(count('web'), 'time', 'times')}` : undefined,
    count('agent') > 0 ? `ran ${plural(count('agent'), 'subagent', 'subagents')}` : undefined,
    others > 0 ? `used ${plural(others, 'tool', 'tools')}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const sentence = parts.join(' · ');

  if (sentence.length === 0) {
    return entries.some((entry) => entry.kind === 'reasoning') ? 'Thought' : 'Worked';
  }

  return `${sentence[0]?.toUpperCase() ?? ''}${sentence.slice(1)}`;
}

/** `+12 −3` over every change a group's entries made. */
export function workDiffStat(entries: readonly WorkEntry[]): {
  readonly added: number;
  readonly removed: number;
} {
  let added = 0;
  let removed = 0;

  for (const entry of entries) {
    const patches = entry.kind === 'patch' ? [entry] : entry.kind === 'tool' ? entry.patches : [];

    for (const patch of patches) {
      const stat = diffStat(patch.diff);
      added += stat.added;
      removed += stat.removed;
    }
  }

  return { added, removed };
}

/** What the run is doing right now, for the live row at the foot of the conversation. */
export interface LiveActivity {
  /** Whether it is working (animated, timed) or waiting on something (still). */
  readonly isActive: boolean;
  readonly label: string;
}

const PREPARING: Readonly<Record<string, string>> = {
  creating: 'Creating your workspace',
  hibernating: 'Waiting for the workspace to settle',
  releasing: 'Releasing the workspace',
  resuming: 'Waking your workspace',
};

/**
 * The live row's words, from the run's status and the rows so far (t3code's working/thinking
 * rows). `undefined` when the run is not live — finished, or not read yet — so nothing claims work
 * that is not happening. The tool currently running is named on its own line in the work group;
 * this says what the run as a whole is doing, including the stretches no row covers: the queue,
 * the workspace starting, and the turn-end commit between the last word and `succeeded`.
 */
export function liveActivity(
  run: RunResponse | undefined,
  rows: readonly TimelineRow[],
  options: {
    readonly isStopping?: boolean;
    /** Nothing new has arrived for a moment: a reply that has finished streaming. */
    readonly isQuiet?: boolean;
    /** The last `sandbox.preparing` transition, while the run is `starting`. */
    readonly preparing?: string | undefined;
  } = {},
): LiveActivity | undefined {
  if (run === undefined) return undefined;

  switch (run.status) {
    case 'cancelled':
    case 'failed':
    case 'succeeded': {
      return undefined;
    }
    case 'awaiting_input': {
      return { isActive: false, label: 'Waiting for your reply' };
    }
    case 'paused': {
      return { isActive: false, label: 'Paused' };
    }
    case 'queued': {
      return { isActive: true, label: 'Queued — waiting for a free worker' };
    }
    case 'starting': {
      return {
        isActive: true,
        label:
          (options.preparing === undefined ? undefined : PREPARING[options.preparing]) ??
          'Starting',
      };
    }
    case 'tool_error':
    case 'running': {
      if (options.isStopping === true) {
        return { isActive: true, label: 'Stopping after the current step' };
      }
      if (run.status === 'tool_error') {
        return { isActive: true, label: 'A step failed — working out a fix' };
      }

      const last = rows.at(-1);

      if (last?.kind === 'work') {
        const entry = last.entries.at(-1);

        if (entry?.kind === 'tool' && entry.status === 'running') {
          return { isActive: true, label: 'Working' };
        }

        // Thinking aloud, or every call has answered and the model is reading the results.
        return { isActive: true, label: 'Thinking' };
      }

      // After the reply has stopped arriving, the turn-end commit (`checkpoint`) still runs before
      // the run says `succeeded` — the stretch that used to look like a finished run holding Stop.
      if (last?.kind === 'assistant') {
        return { isActive: true, label: options.isQuiet === true ? 'Wrapping up' : 'Writing' };
      }

      return { isActive: true, label: 'Working' };
    }
  }
}

/** "1m 20s", "45s", "2h 5m": how long a finished turn worked. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;

  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}
