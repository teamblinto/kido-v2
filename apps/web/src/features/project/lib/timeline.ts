import type { RunEvent } from '@repo/contracts';

import type { ToolKind, ToolStatus } from '../types';
import { type TranscriptItem, joinTokens } from './transcript';

/**
 * The chat's rows, from the transcript (spec 043): the person's messages, the assistant's text as
 * one message per stretch of tokens, consecutive tool calls and file changes as one work group,
 * and the run's other notices as they came. Pure, so the grouping rules are tested without a DOM.
 */

/** Something the person sent: the run's prompt, or an answer to a run waiting for input. */
export interface UserTurn {
  /** Where it sits: before the joined transcript item at this index (`Infinity`: at the end). */
  readonly at: number;
  readonly id: string;
  readonly text: string;
}

export type WorkEntry =
  | {
      readonly detail?: string;
      readonly id: string;
      readonly kind: 'tool';
      readonly status: ToolStatus;
      readonly title: string;
      readonly tool: ToolKind;
    }
  | { readonly id: string; readonly kind: 'patch'; readonly path: string };

export type TimelineRow =
  | { readonly id: string; readonly kind: 'assistant'; readonly text: string }
  | { readonly event: RunEvent; readonly id: string; readonly kind: 'notice' }
  | { readonly id: string; readonly kind: 'user'; readonly text: string }
  | { readonly entries: readonly WorkEntry[]; readonly id: string; readonly kind: 'work' };

/** The tool's icon family, from its name. Unrecognised tools get the neutral one. */
export function toolKind(tool: string): ToolKind {
  if (tool.includes('edit') || tool.includes('write') || tool.includes('file')) {
    return 'edit';
  }

  return tool.includes('install') || tool.includes('package') || tool.startsWith('pkg')
    ? 'package'
    : 'exec';
}

/** Events with no row of their own; they neither show nor break a work group. */
function isSilent(event: RunEvent): boolean {
  switch (event.type) {
    // `tool.end` is the other half of its `tool.start`; `tool.delta` is the activity log's; usage
    // is on the run record. Approvals are history from retired local-agent runs (spec 040).
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
  const ends = new Map<string, Extract<RunEvent, { type: 'tool.end' }>>();

  for (const { event } of joined) {
    if (event.type === 'tool.end') ends.set(event.data.stepId, event);
  }

  const rows: TimelineRow[] = [];
  const pending = [...turns].sort((a, b) => a.at - b.at);
  let work: WorkEntry[] | undefined;

  const flushTurns = (index: number): void => {
    while (pending[0] !== undefined && pending[0].at <= index) {
      const turn = pending.shift();
      if (turn === undefined) break;
      work = undefined;
      rows.push({ id: turn.id, kind: 'user', text: turn.text });
    }
  };

  joined.forEach((item, index) => {
    flushTurns(index);
    const { event } = item;

    if (isSilent(event)) return;

    if (event.type === 'tool.start' || event.type === 'file.patch') {
      if (work === undefined) {
        work = [];
        rows.push({ entries: work, id: item.id, kind: 'work' });
      }

      if (event.type === 'file.patch') {
        work.push({ id: item.id, kind: 'patch', path: event.data.path });
      } else {
        const end = ends.get(event.data.stepId);
        const status: ToolStatus = end === undefined ? 'running' : end.data.ok ? 'done' : 'failed';
        work.push({
          ...(end?.data.error === undefined ? {} : { detail: end.data.error }),
          id: item.id,
          kind: 'tool',
          status,
          title: event.data.tool,
          tool: toolKind(event.data.tool),
        });
      }

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

/** "Edited 2 files · ran 3 commands" — what a work group did, counted from its entries. */
export function workSummary(entries: readonly WorkEntry[]): string {
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const paths = new Set(entries.flatMap((entry) => (entry.kind === 'patch' ? [entry.path] : [])));
  const edits = paths.size > 0 ? paths.size : tools.filter((tool) => tool.tool === 'edit').length;
  const commands = tools.filter((tool) => tool.tool === 'exec').length;
  const packages = tools.filter((tool) => tool.tool === 'package').length;
  const parts = [
    edits > 0 ? `edited ${plural(edits, 'file', 'files')}` : undefined,
    commands > 0 ? `ran ${plural(commands, 'command', 'commands')}` : undefined,
    packages > 0 ? `installed ${plural(packages, 'package', 'packages')}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const sentence = parts.join(' · ');

  return sentence.length === 0
    ? 'Worked'
    : `${sentence[0]?.toUpperCase() ?? ''}${sentence.slice(1)}`;
}

/** "1m 20s", "45s", "2h 5m": how long a finished turn worked. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;

  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}
