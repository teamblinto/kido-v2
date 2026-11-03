import type { RunMessage } from '@repo/db';
import { describe, expect, it, vi } from 'vitest';

import { ScriptedProvider } from '../../../../test/support/scripted-provider';
import type { CredentialContext } from '../llm-provider.port';
import { SUMMARY_PROMPT, toMessages } from '../prompt';
import { summarise, type SummaryScope, type SummaryState } from './summary';

const AT = new Date('2026-09-21T10:11:12.000Z');
/** 30 000 chars ≈ 7 500 tokens per result: 10 turns ≈ 75 000, over the 60 000 threshold. */
const BIG = 'x'.repeat(30_000);
const EMPTY: SummaryState = { summary: null, throughMessageId: null, tokens: 0 };

function row(id: string, role: RunMessage['role'], content: string, toolCalls: unknown[] = []) {
  return {
    at: AT,
    content,
    createdAt: AT,
    id,
    orgId: 'org_1',
    role,
    runId: 'run_1',
    toolCalls,
    updatedAt: AT,
  } satisfies RunMessage;
}

/** A prompt then `turns` turns of one call each; `pending` leaves the last call without its result. */
function conversation(turns: number, options: { pending?: boolean; from?: number } = {}) {
  const rows: RunMessage[] = options.from ? [] : [row('u0', 'user', 'fix the bug')];
  for (let turn = (options.from ?? 0) + 1; turn <= turns; turn += 1) {
    rows.push(
      row(`a${String(turn)}`, 'assistant', `decision ${String(turn)}`, [
        { id: `c${String(turn)}`, input: { path: `f${String(turn)}.ts` }, name: 'fs_read' },
      ]),
    );
    if (options.pending && turn === turns) break;
    rows.push(
      row(
        `t${String(turn)}`,
        'tool',
        JSON.stringify([{ content: BIG, isError: false, toolUseId: `c${String(turn)}` }]),
      ),
    );
  }
  return rows;
}

function scope(provider: ScriptedProvider, overrides: Partial<SummaryScope> = {}): SummaryScope {
  const credential: CredentialContext = {
    apiKey: 'sk-ant-test',
    mode: 'BYOK',
    provider: 'anthropic',
  };
  return {
    credential,
    emit: vi.fn<SummaryScope['emit']>(() => Promise.resolve()),
    provider,
    summaryMs: 1000,
    ...overrides,
  };
}

describe('summarise', () => {
  it('under the threshold sends every message and makes no call', async () => {
    const provider = new ScriptedProvider();
    const rows = conversation(2);

    const result = await summarise(scope(provider), rows, EMPTY);

    expect(result.messages).toEqual(toMessages(rows));
    expect(result.update).toBeUndefined();
    expect(result.skipped).toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it('over the threshold cuts after the tool row that closes turn N-6 so every call and its result stay together', async () => {
    const provider = new ScriptedProvider().script({ text: 'decisions 1-4' });
    const rows = conversation(10);

    const result = await summarise(scope(provider), rows, EMPTY);

    // Tail = turns 5..10 verbatim, each call with its result; the cut is after t4.
    expect(result.messages).toEqual([
      { content: `Summary of the conversation so far:\ndecisions 1-4`, role: 'user' },
      ...toMessages(rows.slice(rows.findIndex((r) => r.id === 'a5'))),
    ]);
    expect(result.messages).toHaveLength(1 + 12);
    expect(result.update).toMatchObject({ summary: 'decisions 1-4', throughMessageId: 't4' });
    expect(result.update?.tokens).toBeGreaterThan(0);
    // The cheap model saw the aged rows as data under the versioned prompt.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.request.system).toBe(SUMMARY_PROMPT);
    expect(provider.calls[0]?.request.tools).toEqual([]);
    const sent = JSON.stringify(provider.calls[0]?.request.messages);
    expect(sent).toContain('fix the bug');
    expect(sent).toContain('decision 4');
    expect(sent).toContain('f4.ts');
    expect(sent).not.toContain('decision 5');
  });

  it('a dispatch-boundary resume keeps the pending call inside the tail', async () => {
    const provider = new ScriptedProvider().script({ text: 's' });
    const rows = conversation(10, { pending: true });

    const result = await summarise(scope(provider), rows, EMPTY);

    expect(result.update?.throughMessageId).toBe('t4');
    const last = result.messages.at(-1);
    expect(last).toEqual({
      role: 'assistant',
      text: 'decision 10',
      toolCalls: [{ id: 'c10', input: { path: 'f10.ts' }, name: 'fs_read' }],
    });
  });

  it('the first crossing summarises the aged rows; the second extends from the previous summary and only the newly aged rows', async () => {
    const provider = new ScriptedProvider().script({ text: 'first' }, { text: 'first + more' });
    const rows = conversation(10);
    const first = await summarise(scope(provider), rows, EMPTY);
    const later = [...rows, ...conversation(18, { from: 10 })];

    const second = await summarise(scope(provider), later, first.update!);

    expect(second.update).toMatchObject({ summary: 'first + more', throughMessageId: 't12' });
    expect(second.messages[0]).toEqual({
      content: 'Summary of the conversation so far:\nfirst + more',
      role: 'user',
    });
    expect(second.messages).toHaveLength(1 + 12);
    expect(provider.calls).toHaveLength(2);
    const sent = JSON.stringify(provider.calls[1]?.request.messages);
    expect(sent).toContain('first');
    expect(sent).toContain('decision 5');
    expect(sent).toContain('decision 12');
    expect(sent).not.toContain('decision 4');
    expect(sent).not.toContain('decision 13');
  });

  it('a single enormous first message is sent as is', async () => {
    const provider = new ScriptedProvider();
    const rows = [row('u0', 'user', BIG.repeat(10))];

    const result = await summarise(scope(provider), rows, EMPTY);

    expect(result.messages).toEqual(toMessages(rows));
    expect(result.update).toBeUndefined();
    expect(result.skipped).toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it('a failed or timed-out call answers verbatim and a summary skip', async () => {
    const rows = conversation(10);

    const failed = new ScriptedProvider().script({ fail: 'rate-limited' });
    const onFailure = await summarise(scope(failed), rows, EMPTY);
    expect(onFailure.messages).toEqual(toMessages(rows));
    expect(onFailure.update).toBeUndefined();
    expect(onFailure.skipped).toBe('rate-limited');

    const hung = new ScriptedProvider().script({ hang: true });
    const onTimeout = await summarise(scope(hung, { summaryMs: 5 }), rows, EMPTY);
    expect(onTimeout.messages).toEqual(toMessages(rows));
    expect(onTimeout.update).toBeUndefined();
    expect(onTimeout.skipped).toBe('timeout');
  });

  it("emits a usage event with source summary on the run's credential mode", async () => {
    const usage = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 50, outputTokens: 7 };
    const provider = new ScriptedProvider().script({ text: 's', usage });
    const rows = conversation(10);
    const s = scope(provider);

    await summarise(s, rows, EMPTY);

    expect(s.emit).toHaveBeenCalledTimes(1);
    expect(s.emit).toHaveBeenCalledWith({
      data: { costMicros: 0, ...usage, source: 'summary' },
      type: 'usage',
    });
    expect(provider.calls[0]?.credential).toEqual(s.credential);
    expect(provider.calls[0]?.model).toBe('claude-haiku-4-5');

    const openai = new ScriptedProvider().script({ text: 's' });
    await summarise(
      scope(openai, { credential: { apiKey: 'sk-test', mode: 'BYOK', provider: 'openai' } }),
      rows,
      EMPTY,
    );
    expect(openai.calls[0]?.model).toBe('gpt-5-mini');
    expect(openai.calls[0]?.credential.mode).toBe('BYOK');
  });
});
