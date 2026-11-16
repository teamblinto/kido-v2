import type { RunMessage } from '@repo/contracts';

import type { UserTurn } from './timeline';
import { type TranscriptItem, joinTokens } from './transcript';

const time = (iso: string): number => Date.parse(iso);

const turnOf = (message: RunMessage, at: number): UserTurn => ({
  at,
  id: `m-${message.id}`,
  ...(message.role === 'assistant'
    ? { role: 'assistant' as const }
    : message.attachments.length === 0
      ? {}
      : { attachments: message.attachments }),
  text: message.content,
});

/**
 * What the record adds to the screen (the conversation read back), as turns for `buildTimeline`.
 *
 * The run's events say what it did, never what was said: `token`s are not stored, and only a
 * run's first prompt rides on its record. So a reopened project's replies and follow-ups exist in
 * `messages` alone, and are placed here among the events by time.
 *
 * - Runs before the one on screen come first, so the conversation reads from its start. A newer run
 *   is left out: someone reading an old run is reading up to that point.
 * - What this session already shows is skipped: a message the person sent from this screen (`sent`,
 *   one each, so a repeated prompt from an earlier session still appears), and a reply whose tokens
 *   streamed here.
 *
 * shortcut: a reply this session only caught the end of keeps the tokens it saw until a reload,
 * because swapping them for the record would move text the reader is already looking at.
 */
export function recordedTurns(
  messages: readonly RunMessage[],
  runId: string | undefined,
  items: readonly TranscriptItem[],
  sent: readonly { readonly runId?: string | undefined; readonly text: string }[],
): UserTurn[] {
  const joined = joinTokens(items);
  const own = messages.filter((message) => message.runId === runId);
  const opening = own[0] === undefined ? Number.POSITIVE_INFINITY : time(own[0].at);
  const earlier = messages.filter(
    (message) => message.runId !== runId && time(message.at) < opening,
  );
  const unmatched = [...sent];
  const turns: UserTurn[] = [];

  for (const [index, message] of [...own.entries()].reverse()) {
    if (message.role === 'user') {
      const local = unmatched.findIndex(
        (turn) => turn.runId === runId && turn.text === message.content,
      );

      if (local !== -1) {
        unmatched.splice(local, 1);
        continue;
      }
    } else {
      const from = index === 0 ? 0 : time(own[index - 1]?.at ?? '');
      const streamed = joined.some(
        ({ event }) =>
          event.type === 'token' && time(event.at) > from && time(event.at) <= time(message.at),
      );

      if (streamed) continue;
    }

    turns.unshift(
      turnOf(message, joined.filter(({ event }) => time(event.at) <= time(message.at)).length),
    );
  }

  return [...earlier.map((message) => turnOf(message, -1)), ...turns];
}
