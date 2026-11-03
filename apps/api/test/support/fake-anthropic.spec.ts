import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeAnthropic, type FakeAnthropic } from './fake-anthropic';

function parseSse(text: string): { event: string; data: unknown }[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))!.slice('event: '.length);
      const data = lines.find((line) => line.startsWith('data: '))!.slice('data: '.length);
      return { event, data: JSON.parse(data) as unknown };
    });
}

describe('fake-anthropic', () => {
  let fake: FakeAnthropic;

  beforeEach(async () => {
    fake = startFakeAnthropic();
    await fake.start();
  });

  afterEach(() => fake.close());

  it('parses a scripted reply into the expected SSE event sequence', async () => {
    fake.script({
      reply: {
        text: 'hi',
        toolUse: [{ id: 'toolu_1', name: 'fs_read', input: { path: 'README.md' } }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'tool_use',
      },
    });

    const response = await fetch(`${fake.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-fake' },
      body: JSON.stringify({ model: 'claude-fake' }),
    });
    expect(response.status).toBe(200);

    const events = parseSse(await response.text());
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const start = events[0]!.data as { message: { usage: { input_tokens: number } } };
    expect(start.message.usage.input_tokens).toBe(10);

    const textDelta = events[2]!.data as { delta: { type: string; text: string } };
    expect(textDelta.delta).toEqual({ type: 'text_delta', text: 'hi' });

    const toolStart = events[4]!.data as { content_block: { type: string; name: string } };
    expect(toolStart.content_block).toMatchObject({ type: 'tool_use', name: 'fs_read' });

    const toolDeltas = events
      .slice(5, 7)
      .map((e) => (e.data as { delta: { partial_json: string } }).delta.partial_json);
    expect(JSON.parse(toolDeltas.join(''))).toEqual({ path: 'README.md' });

    const messageDelta = events[8]!.data as {
      delta: { stop_reason: string };
      usage: { output_tokens: number };
    };
    expect(messageDelta.delta.stop_reason).toBe('tool_use');
    expect(messageDelta.usage.output_tokens).toBe(5);

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.headers.authorization).toBe('Bearer sk-fake');
  });

  it('answers 200 before a hang, so the client waits on the body and not the connection', async () => {
    fake.script({ hang: true });

    const response = await fetch(`${fake.baseURL}/v1/messages`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const body = response.text();
    body.catch(() => undefined);
    await fake.close();
    await expect(body).rejects.toThrow();
  });

  it('answers 200 and half the events before dropping the socket mid-stream', async () => {
    fake.script({ dropMidStream: true });

    const response = await fetch(`${fake.baseURL}/v1/messages`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });

  it('returns a scripted status with its body and headers', async () => {
    fake.script({
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      headers: { 'request-id': 'req_abc', 'retry-after': '2' },
    });

    const response = await fetch(`${fake.baseURL}/v1/messages`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(429);
    expect(response.headers.get('request-id')).toBe('req_abc');
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
  });
});
