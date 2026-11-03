import type { TranscriptItem } from './transcript';

/**
 * What the stage's panes can honestly show, read out of the transcript.
 *
 * Every function here is a direct reading of an event the stream already carries (FR-029). None
 * of them fetches, and none of them infers: a pane with nothing to read renders an empty state,
 * because "nothing has happened yet" and "we made something up" must never look the same
 * (FR-003, FR-028).
 *
 * Derived on each render rather than accumulated alongside the transcript, so there is one source
 * for what the run did — the events — and no second copy to keep in step with it.
 */

/**
 * The files this run has changed, newest first, each named once.
 *
 * A run patches the same file repeatedly, so the distinct `path` values are the list a person
 * means by "what changed"; the most recently touched leads, because that is what was just done.
 */
export function changedPaths(items: readonly TranscriptItem[]): string[] {
  const paths: string[] = [];

  for (const { event } of [...items].reverse()) {
    if (event.type === 'file.patch' && !paths.includes(event.data.path)) {
      paths.push(event.data.path);
    }
  }

  return paths;
}

/**
 * Where the preview is, if the run has said.
 *
 * The most recent `preview.ready` wins: a run that rebuilds announces a new one, and showing the
 * first would leave a person looking at a preview the run has already replaced.
 */
export function previewUrl(items: readonly TranscriptItem[]): string | undefined {
  for (const { event } of [...items].reverse()) {
    if (event.type === 'preview.ready') {
      return event.data.url;
    }
  }

  return undefined;
}

/** One line of build output, as the activity log shows it. */
export interface ActivityLine {
  readonly id: string;
  readonly isProblem: boolean;
  readonly message: string;
  readonly time: string;
}

/** The run's own clock, as a wall time. An unparseable timestamp shows nothing rather than NaN. */
function clock(at: string): string {
  const moment = new Date(at);

  return Number.isNaN(moment.getTime()) ? '' : moment.toLocaleTimeString();
}

/**
 * The build output: what the tools wrote, and what they said when they failed.
 *
 * `tool.delta` is a tool's output as it streams, which is exactly what this pane is for. A failed
 * `tool.end` carries the run's own words for what went wrong, and those are the lines the
 * "problems only" filter keeps — the classification is the run's, not a guess made from the text.
 */
export function activityLines(items: readonly TranscriptItem[]): ActivityLine[] {
  const lines: ActivityLine[] = [];

  for (const { event, id } of items) {
    if (event.type === 'tool.delta') {
      for (const [index, chunk] of event.data.chunk.split('\n').entries()) {
        if (chunk.trim().length > 0) {
          lines.push({
            id: `${id}-${String(index)}`,
            isProblem: false,
            message: chunk,
            time: clock(event.at),
          });
        }
      }
    }

    if (event.type === 'tool.end' && !event.data.ok && event.data.error !== undefined) {
      lines.push({ id, isProblem: true, message: event.data.error, time: clock(event.at) });
    }
  }

  return lines;
}
