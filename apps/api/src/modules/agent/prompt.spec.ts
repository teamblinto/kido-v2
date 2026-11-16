import type { RunMessage } from '@repo/db';
import { describe, expect, it } from 'vitest';

import {
  estimateTokens,
  resumeBoundary,
  SUMMARY_PROMPT,
  SUMMARY_PROMPT_VERSION,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_VERSION,
  toMessages,
} from './prompt';

function row(partial: Partial<RunMessage> & { role: RunMessage['role'] }): RunMessage {
  return {
    at: new Date('2026-09-16T00:00:00.000Z'),
    content: '',
    createdAt: new Date('2026-09-16T00:00:00.000Z'),
    id: 'row-id',
    orgId: 'org-id',
    runId: 'run-id',
    toolCalls: [],
    updatedAt: new Date('2026-09-16T00:00:00.000Z'),
    ...partial,
  };
}

describe('SYSTEM_PROMPT', () => {
  it('carries no timestamp or id', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(SYSTEM_PROMPT).not.toContain('run-id');
  });

  it('SYSTEM_PROMPT_VERSION is a stable string', () => {
    expect(SYSTEM_PROMPT_VERSION).toBe('2026-11-16.1');
  });
});

describe('SUMMARY_PROMPT', () => {
  it('carries no timestamp or id', () => {
    expect(SUMMARY_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(SUMMARY_PROMPT).not.toContain('run-id');
  });

  it('asks for what was asked, decided, changed and where, extending the previous summary', () => {
    expect(SUMMARY_PROMPT).toMatch(/asked/);
    expect(SUMMARY_PROMPT).toMatch(/decided/);
    expect(SUMMARY_PROMPT).toMatch(/changed/);
    expect(SUMMARY_PROMPT).toMatch(/where/);
    expect(SUMMARY_PROMPT).toMatch(/previous summary/);
  });

  it('SUMMARY_PROMPT_VERSION is a stable string', () => {
    expect(SUMMARY_PROMPT_VERSION).toBe('2026-09-21.1');
  });
});

describe('estimateTokens', () => {
  it('is 0 for no messages', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('is ceil(chars / 4) over the serialised content', () => {
    // 9 chars → ceil(9 / 4) = 3
    expect(estimateTokens([{ content: 'abcdefghi', role: 'user' }])).toBe(3);
    // 4 + 4 chars → 2
    expect(
      estimateTokens([
        { content: 'abcd', role: 'user' },
        { content: 'abcd', role: 'user' },
      ]),
    ).toBe(2);
  });

  it('counts assistant text, tool call input and tool results', () => {
    expect(estimateTokens([{ content: 'x'.repeat(400), role: 'user' }])).toBe(100);
    expect(
      estimateTokens([
        {
          role: 'assistant',
          text: 'x'.repeat(400),
          toolCalls: [{ id: 'call-1', input: { path: 'y'.repeat(400) }, name: 'fs_read' }],
        },
      ]),
    ).toBeGreaterThanOrEqual(200);
    expect(
      estimateTokens([
        {
          results: [{ content: 'z'.repeat(400), isError: false, toolUseId: 'call-1' }],
          role: 'tool',
        },
      ]),
    ).toBeGreaterThanOrEqual(100);
  });
});

describe('toMessages', () => {
  it('maps a user row to a user message', () => {
    const rows = [row({ content: 'hello', role: 'user' })];

    expect(toMessages(rows)).toEqual([{ content: 'hello', role: 'user' }]);
  });

  it('maps an assistant row with tool_calls to text + tool_use blocks', () => {
    const rows = [
      row({
        content: 'thinking out loud',
        role: 'assistant',
        toolCalls: [{ id: 'call-1', input: { path: 'a.txt' }, name: 'fs_read' }],
      }),
    ];

    expect(toMessages(rows)).toEqual([
      {
        role: 'assistant',
        text: 'thinking out loud',
        toolCalls: [{ id: 'call-1', input: { path: 'a.txt' }, name: 'fs_read' }],
      },
    ]);
  });

  it('an assistant row with empty text has no text block', () => {
    const rows = [
      row({
        content: '',
        role: 'assistant',
        toolCalls: [{ id: 'call-1', input: {}, name: 'exec' }],
      }),
    ];

    const [message] = toMessages(rows);

    expect(message).toEqual({
      role: 'assistant',
      toolCalls: [{ id: 'call-1', input: {}, name: 'exec' }],
    });
    expect(message).not.toHaveProperty('text');
  });

  it('maps a tool row to one user message of tool_result blocks in order', () => {
    const rows = [
      row({
        content: JSON.stringify([
          { content: 'exit 0', isError: false, toolUseId: 'call-1' },
          { content: 'boom', isError: true, toolUseId: 'call-2' },
        ]),
        role: 'tool',
      }),
    ];

    expect(toMessages(rows)).toEqual([
      {
        results: [
          { content: 'exit 0', isError: false, toolUseId: 'call-1' },
          { content: 'boom', isError: true, toolUseId: 'call-2' },
        ],
        role: 'tool',
      },
    ]);
  });

  it('keeps at order', () => {
    const rows = [
      row({ at: new Date('2026-09-16T00:00:02.000Z'), content: 'second', role: 'user' }),
      row({ at: new Date('2026-09-16T00:00:01.000Z'), content: 'first', role: 'user' }),
    ];

    expect(toMessages(rows)).toEqual([
      { content: 'second', role: 'user' },
      { content: 'first', role: 'user' },
    ]);
  });

  it('a request built twice from the same rows is deep-equal', () => {
    const rows = [
      row({ content: 'hello', role: 'user' }),
      row({
        content: 'reading',
        role: 'assistant',
        toolCalls: [{ id: 'call-1', input: { path: 'a.txt' }, name: 'fs_read' }],
      }),
      row({
        content: JSON.stringify([{ content: 'ok', isError: false, toolUseId: 'call-1' }]),
        role: 'tool',
      }),
    ];

    expect(toMessages(rows)).toEqual(toMessages(rows));
  });
});

describe('resumeBoundary', () => {
  it("is 'dispatch' when the last row is an assistant row with tool_calls and no tool row after it", () => {
    const rows = [
      row({ content: 'hello', role: 'user' }),
      row({
        content: '',
        role: 'assistant',
        toolCalls: [{ id: 'call-1', input: {}, name: 'exec' }],
      }),
    ];

    expect(resumeBoundary(rows)).toBe('dispatch');
  });

  it("is 'call' when the last row is a user row", () => {
    const rows = [row({ content: 'hello', role: 'user' })];

    expect(resumeBoundary(rows)).toBe('call');
  });

  it("is 'call' when the last row is a tool row", () => {
    const rows = [
      row({
        content: '',
        role: 'assistant',
        toolCalls: [{ id: 'call-1', input: {}, name: 'exec' }],
      }),
      row({
        content: JSON.stringify([{ content: 'ok', isError: false, toolUseId: 'call-1' }]),
        role: 'tool',
      }),
    ];

    expect(resumeBoundary(rows)).toBe('call');
  });

  it("is 'call' when the last row is an assistant row with no tool_calls", () => {
    const rows = [row({ content: 'all done', role: 'assistant', toolCalls: [] })];

    expect(resumeBoundary(rows)).toBe('call');
  });
});
