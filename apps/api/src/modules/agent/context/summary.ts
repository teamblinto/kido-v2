import { MODEL_CATALOGUE } from '@repo/contracts';
import type { RunMessage } from '@repo/db';

import { SUMMARY_TAIL_TURNS, SUMMARY_THRESHOLD_TOKENS } from '../agent.constants';
import type { ConversationMessage, CredentialContext, LlmProvider } from '../llm-provider.port';
import { estimateTokens, SUMMARY_PROMPT, toMessages } from '../prompt';
import { classify } from '../provider-error';
import type { ExecutionContext } from '../run-executor.port';

/** What the summary needs from the attempt (T021 builds it from `AttemptScope` + the provider). */
export interface SummaryScope {
  readonly credential: CredentialContext;
  readonly provider: LlmProvider;
  readonly emit: ExecutionContext['emit'];
  /** `AgentTimings.summaryMs` (R8). */
  readonly summaryMs: number;
}

/** The three `agent_runs` columns (data-model.md). */
export interface SummaryState {
  readonly summary: string | null;
  readonly throughMessageId: string | null;
  readonly tokens: number;
}

export interface SummaryResult {
  readonly messages: readonly ConversationMessage[];
  /** Set when a summary call succeeded: T021 persists it before the model call. */
  readonly update?: { summary: string; throughMessageId: string; tokens: number };
  /** Set when the call failed or timed out: the reason for the `context_skips` row. */
  readonly skipped?: string;
}

/** The cheap model per provider (R4); the id must be in the catalogue. */
const CHEAP_MODEL: Record<CredentialContext['provider'], string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
};
for (const id of Object.values(CHEAP_MODEL))
  if (!MODEL_CATALOGUE.some((model) => model.id === id))
    throw new Error(`summary: cheap model ${id} is not in MODEL_CATALOGUE`);

/** The summary may take a quarter of the threshold; past that it is re-compacted, then cut. */
const SUMMARY_BUDGET_TOKENS = SUMMARY_THRESHOLD_TOKENS / 4;
const TRUNCATED = '\n[summary truncated]';
const SUMMARY_HEADER = 'Summary of the conversation so far:\n';

function tokensOf(text: string): number {
  return estimateTokens([{ content: text, role: 'user' }]);
}

/**
 * Index just past the row that closes turn N-6, with N the assistant messages in `messages`; 0
 * when fewer than `SUMMARY_TAIL_TURNS + 1` turns exist. A turn closes at its `tool` row, or at the
 * assistant row itself when it called nothing — so a call and its results never split, and a
 * pending call (dispatch resume) is the last turn, always inside the tail.
 */
function cutIndex(messages: readonly ConversationMessage[]): number {
  const assistants = messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));
  const aged = assistants.length - SUMMARY_TAIL_TURNS;
  if (aged <= 0) return 0;
  const last = assistants[aged - 1]!;
  return messages[last + 1]?.role === 'tool' ? last + 2 : last + 1;
}

function render(messages: readonly ConversationMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'user') return `User:\n${m.content}`;
      if (m.role === 'assistant') {
        const calls = m.toolCalls.map((c) => `[call ${c.name} ${JSON.stringify(c.input)}]`);
        return ['Assistant:', m.text ?? '', ...calls].filter(Boolean).join('\n');
      }
      return m.results
        .map((r) => `Tool result${r.isError ? ' (error)' : ''}:\n${r.content}`)
        .join('\n');
    })
    .join('\n\n');
}

/**
 * US2: under the threshold every message goes verbatim; over it the turns older than the last 6
 * are rolled into the running summary by the provider's cheap model on the run's credential, and
 * the request carries the summary as its first user message then the tail. Pure but for that one
 * call — no DB writes (T021 persists `update` and records `skipped`).
 */
export async function summarise(
  scope: SummaryScope,
  rows: readonly RunMessage[],
  state: SummaryState,
): Promise<SummaryResult> {
  // Rows after the stored marker; a marker no row carries means "from the start" (set-null FK).
  const through =
    state.summary === null ? -1 : rows.findIndex((r) => r.id === state.throughMessageId);
  const remaining = toMessages(rows.slice(through + 1));
  const summaryTokens = through < 0 ? 0 : state.tokens;
  const summaryMessage = (summary: string): ConversationMessage => ({
    content: `${SUMMARY_HEADER}${summary}`,
    role: 'user',
  });
  const carried = through < 0 ? [] : [summaryMessage(state.summary!)];

  const cut = cutIndex(remaining);
  if (summaryTokens + estimateTokens(remaining) <= SUMMARY_THRESHOLD_TOKENS || cut === 0) {
    return { messages: [...carried, ...remaining] };
  }

  const aged = remaining.slice(0, cut);
  const tail = remaining.slice(cut);
  const previous = through < 0 ? null : state.summary!;
  const call = async (content: string): Promise<string | { skipped: string }> => {
    const client = scope.provider.client(scope.credential, CHEAP_MODEL[scope.credential.provider]);
    const signal = AbortSignal.timeout(scope.summaryMs);
    try {
      const turn = await client.complete(
        { messages: [{ content, role: 'user' }], system: SUMMARY_PROMPT, tools: [] },
        { onDelta: () => undefined, signal },
      );
      await scope.emit({
        data: { costMicros: 0, ...turn.usage, source: 'summary' },
        type: 'usage',
      });
      return turn.text;
    } catch (error) {
      return { skipped: signal.aborted ? 'timeout' : classify(error).class };
    }
  };

  let summary = await call(
    (previous === null ? '' : `Previous summary:\n${previous}\n\n`) +
      `New turns:\n\n${render(aged)}`,
  );
  if (typeof summary !== 'string') {
    return { messages: [...carried, ...remaining], skipped: summary.skipped };
  }
  // Re-compaction once when the summary outgrew its budget; a marker cut after that.
  if (tokensOf(summary) > SUMMARY_BUDGET_TOKENS) {
    const compacted = await call(
      `Previous summary:\n${summary}\n\nNew turns:\n\n(none — compact the summary)`,
    );
    if (typeof compacted === 'string') summary = compacted;
    if (tokensOf(summary) > SUMMARY_BUDGET_TOKENS)
      summary = summary.slice(0, SUMMARY_BUDGET_TOKENS * 4 - TRUNCATED.length) + TRUNCATED;
  }

  return {
    messages: [summaryMessage(summary), ...tail],
    update: { summary, throughMessageId: rows[through + cut]!.id, tokens: tokensOf(summary) },
  };
}
