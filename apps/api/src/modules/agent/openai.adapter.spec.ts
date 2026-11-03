import OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_OUTPUT_TOKENS } from './agent.constants';
import type { CredentialContext, Delta, ModelRequest } from './llm-provider.port';
import { durationMs, OpenAiProvider } from './openai.adapter';
import { ProviderError } from './provider-error';
import { toInputSchema } from './tool-schema';

const CREDENTIAL: CredentialContext = {
  mode: 'BYOK',
  provider: 'openai',
  apiKey: 'sk-proj-test-key-aaaaaaaa',
  keyLastFour: 'aaaa',
};
const MODEL = 'gpt-5.2';

const REQUEST: ModelRequest = {
  system: 'You are the agent.',
  tools: [
    {
      name: 'fs_read',
      description: 'Read a file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'fs_edit',
      description: 'Edit a file.',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        anyOf: [
          {
            type: 'object',
            properties: { content: { type: 'string' }, path: { type: 'string' } },
            required: ['content', 'path'],
          },
          {
            type: 'object',
            properties: { path: { type: 'string' }, search: { type: 'string' } },
            required: ['path', 'search'],
          },
        ],
      },
    },
  ],
  messages: [
    { role: 'user', content: 'read README' },
    {
      role: 'assistant',
      text: 'Reading.',
      toolCalls: [{ id: 'call_1', name: 'fs_read', input: { path: 'README.md' } }],
    },
    {
      role: 'tool',
      results: [
        { toolUseId: 'call_1', content: '# hi', isError: false },
        { toolUseId: 'call_2', content: 'ENOENT', isError: true },
      ],
    },
  ],
};

const USAGE = { input_tokens: 10, output_tokens: 5 };

interface Logged {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A scripted `fetch`: one queued answer per call, every request logged. */
function fetchDouble() {
  const requests: Logged[] = [];
  const answers: ((init: RequestInit) => Promise<Response>)[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : '',
    });
    const answer = answers.shift();
    if (!answer) throw new Error('fetch double: nothing scripted');
    return answer(init);
  };
  return {
    fetch,
    requests,
    script: (answer: (init: RequestInit) => Promise<Response>) => answers.push(answer),
    json: (status: number, body: unknown, headers: Record<string, string> = {}) =>
      answers.push(() =>
        Promise.resolve(
          Response.json(body, { status, headers: { 'request-id': 'req_fake_0001', ...headers } }),
        ),
      ),
    /** Responses API SSE: `event: <type>\ndata: <json>\n\n` per event, then the stream closes. */
    sse: (events: readonly { type: string; [key: string]: unknown }[]) =>
      answers.push(() => {
        const text = events
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join('');
        return Promise.resolve(
          new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      }),
  };
}

type Item =
  | {
      type: 'message';
      content: { type: 'output_text' | 'refusal'; text?: string; refusal?: string }[];
    }
  | { type: 'function_call'; call_id: string; name: string; arguments: string };

/** The terminal event carrying the whole response, as `response.completed` / `.incomplete` do. */
function terminal(
  type: 'response.completed' | 'response.incomplete',
  output: Item[],
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    sequence_number: 99,
    response: {
      id: 'resp_1',
      object: 'response',
      status: type === 'response.completed' ? 'completed' : 'incomplete',
      output: output.map((item, index) => ({ id: `item_${index}`, status: 'completed', ...item })),
      usage: USAGE,
      incomplete_details: null,
      error: null,
      ...extra,
    },
  };
}

const textDelta = (delta: string) => ({
  type: 'response.output_text.delta',
  item_id: 'item_0',
  output_index: 0,
  content_index: 0,
  delta,
  logprobs: [],
  sequence_number: 1,
});

describe('OpenAiProvider', () => {
  let fake: ReturnType<typeof fetchDouble>;
  let provider: OpenAiProvider;

  beforeEach(() => {
    fake = fetchDouble();
    provider = new OpenAiProvider({ fetch: fake.fetch, baseURL: 'http://fake.local/v1' });
  });

  function complete(request: ModelRequest = REQUEST, signal = new AbortController().signal) {
    const deltas: Delta[] = [];
    const turn = provider
      .client(CREDENTIAL, MODEL)
      .complete(request, { onDelta: (delta) => deltas.push(delta), signal });
    return { deltas, turn };
  }

  function lastBody(): Record<string, unknown> {
    return JSON.parse(fake.requests.at(-1)!.body) as Record<string, unknown>;
  }

  it('answers a text-only turn as end_turn with the deltas forwarded in order', async () => {
    fake.sse([
      textDelta('Hel'),
      textDelta('lo'),
      terminal('response.completed', [
        { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
      ]),
    ]);

    const { deltas, turn } = complete();
    const result = await turn;

    expect(deltas).toEqual([
      { kind: 'text', text: 'Hel' },
      { kind: 'text', text: 'lo' },
    ]);
    expect(result).toEqual({
      text: 'Hello',
      toolCalls: [],
      stop: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it('answers function_call items as toolCalls with parsed arguments and stop tool_use', async () => {
    fake.sse([
      terminal('response.completed', [
        { type: 'message', content: [{ type: 'output_text', text: 'Let me look.' }] },
        { type: 'function_call', call_id: 'call_9', name: 'fs_read', arguments: '{"path":"a.ts"}' },
        { type: 'function_call', call_id: 'call_10', name: 'exec', arguments: '{"command":"ls"}' },
      ]),
    ]);

    const result = await complete().turn;

    expect(result.text).toBe('Let me look.');
    expect(result.toolCalls).toEqual([
      { id: 'call_9', name: 'fs_read', input: { path: 'a.ts' } },
      { id: 'call_10', name: 'exec', input: { command: 'ls' } },
    ]);
    expect(result.stop).toBe('tool_use');
  });

  it('answers incomplete / max_output_tokens as max_tokens', async () => {
    fake.sse([
      terminal(
        'response.incomplete',
        [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
        { incomplete_details: { reason: 'max_output_tokens' } },
      ),
    ]);

    const result = await complete().turn;

    expect(result.stop).toBe('max_tokens');
    expect(result.text).toBe('partial');
  });

  it('a refusal part is ProviderError refused', async () => {
    fake.sse([
      terminal('response.completed', [
        { type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] },
      ]),
    ]);

    const error: unknown = await complete().turn.then(
      () => 'resolved',
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).class).toBe('refused');
    expect((error as ProviderError).transient).toBe(false);
  });

  it('sends instructions, store false, max_output_tokens, flattened function tools and the mapped conversation', async () => {
    fake.sse([terminal('response.completed', [])]);

    await complete().turn;

    const [request] = fake.requests;
    expect(request!.method).toBe('POST');
    expect(request!.url).toBe('http://fake.local/v1/responses');
    expect(request!.headers.authorization).toBe(`Bearer ${CREDENTIAL.apiKey}`);
    const body = lastBody();
    expect(body.model).toBe(MODEL);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.instructions).toBe(REQUEST.system);
    expect(body.max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'fs_read',
        description: 'Read a file.',
        parameters: REQUEST.tools[0]!.inputSchema,
        strict: false,
      },
      {
        type: 'function',
        name: 'fs_edit',
        description: 'Edit a file.',
        parameters: toInputSchema(REQUEST.tools[1]!.inputSchema),
        strict: false,
      },
    ]);
    expect(body.input).toEqual([
      { role: 'user', content: 'read README' },
      { role: 'assistant', content: 'Reading.' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'fs_read',
        arguments: '{"path":"README.md"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '# hi' },
      { type: 'function_call_output', call_id: 'call_2', output: '[error] ENOENT' },
    ]);
    expect(body).not.toHaveProperty('previous_response_id');
  });

  it('concatenates system, map and excerpts into instructions in that order with blank-line separators, skipping empty blocks', async () => {
    fake.sse([terminal('response.completed', [])]);
    await complete({ ...REQUEST, context: { map: '# map\nsrc/a.ts', excerpts: '' } }).turn;
    expect(lastBody().instructions).toBe('You are the agent.\n\n# map\nsrc/a.ts');

    fake.sse([terminal('response.completed', [])]);
    await complete({ ...REQUEST, context: { map: '# map', excerpts: '## a.ts\nexport x' } }).turn;
    expect(lastBody().instructions).toBe('You are the agent.\n\n# map\n\n## a.ts\nexport x');

    fake.sse([terminal('response.completed', [])]);
    await complete({ ...REQUEST, context: { map: '', excerpts: '' } }).turn;
    expect(lastBody().instructions).toBe('You are the agent.');
  });

  it('reads cached_tokens as cacheReadTokens and 0 cacheWriteTokens', async () => {
    fake.sse([
      terminal('response.completed', [], {
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 8 } },
      }),
    ]);

    const result = await complete().turn;

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
    });
  });

  it('omits the assistant message item when the turn had no text', async () => {
    fake.sse([terminal('response.completed', [])]);

    await complete({
      ...REQUEST,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'fs_read', input: {} }] },
      ],
    }).turn;

    expect(lastBody().input).toEqual([
      { role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'call_1', name: 'fs_read', arguments: '{}' },
    ]);
  });

  it('constructs one SDK client per client() call with maxRetries 0 and holds no key', async () => {
    fake.json(500, { error: { type: 'server_error', message: 'nope' } });

    await expect(complete().turn).rejects.toBeInstanceOf(ProviderError);

    expect(fake.requests).toHaveLength(1);
    const values = Object.values(provider as unknown as Record<string, unknown>);
    expect(values).not.toContain(CREDENTIAL.apiKey);
    expect(values.some((value) => value instanceof OpenAI)).toBe(false);
  });

  it('defaults the base URL to api.openai.com when the transport names none', async () => {
    const urls: string[] = [];
    const capture: typeof globalThis.fetch = (input) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Promise.reject(new Error('captured; no socket'));
    };
    const saved = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9';
    try {
      await expect(
        new OpenAiProvider({ fetch: capture })
          .client(CREDENTIAL, MODEL)
          .complete(REQUEST, { onDelta: vi.fn(), signal: new AbortController().signal }),
      ).rejects.toThrow();
    } finally {
      if (saved === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = saved;
    }

    expect(urls).toEqual(['https://api.openai.com/v1/responses']);
  });

  it('401 is unauthorised, 429 with retry-after is rate-limited with retryAfterMs', async () => {
    fake.json(401, { error: { type: 'invalid_request_error', message: 'bad key' } });
    const unauthorised = (await complete().turn.catch((e: unknown) => e)) as ProviderError;
    expect(unauthorised).toBeInstanceOf(ProviderError);
    expect(unauthorised.class).toBe('unauthorised');
    expect(unauthorised.status).toBe(401);
    expect(unauthorised.requestId).toBe('req_fake_0001');
    expect(unauthorised.message).toBe('unauthorised');

    fake.json(429, { error: { type: 'rate_limit', message: 'slow' } }, { 'retry-after': '7' });
    const limited = (await complete().turn.catch((e: unknown) => e)) as ProviderError;
    expect(limited).toBeInstanceOf(ProviderError);
    expect(limited.class).toBe('rate-limited');
    expect(limited.transient).toBe(true);
    expect(limited.retryAfterMs).toBe(7_000);
  });

  it('429 without retry-after waits for the later x-ratelimit-reset-* (032 T059)', async () => {
    fake.json(
      429,
      { error: { type: 'rate_limit', message: 'slow' } },
      { 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0.5s' },
    );
    const limited = (await complete().turn.catch((e: unknown) => e)) as ProviderError;
    expect(limited.class).toBe('rate-limited');
    expect(limited.retryAfterMs).toBe(360_500);

    fake.json(
      429,
      { error: { type: 'rate_limit', message: 'slow' } },
      { 'retry-after': '7', 'x-ratelimit-reset-tokens': '6m0s' },
    );
    const told = (await complete().turn.catch((e: unknown) => e)) as ProviderError;
    expect(told.retryAfterMs).toBe(7_000);
  });

  it('429 waits only for the exhausted limit when the service says which one', async () => {
    fake.json(
      429,
      { error: { type: 'rate_limit', message: 'slow' } },
      {
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-remaining-tokens': '12000',
        'x-ratelimit-reset-requests': '2s',
        'x-ratelimit-reset-tokens': '6m0s',
      },
    );
    const limited = (await complete().turn.catch((e: unknown) => e)) as ProviderError;
    expect(limited.retryAfterMs).toBe(2_000);
  });

  it('durationMs reads Go-style durations and nothing else', () => {
    expect(durationMs('20ms')).toBe(20);
    expect(durationMs('1h2m3.5s')).toBe(3_723_500);
    for (const junk of ['', '0s', '5', 'soon', '1s later'])
      expect(durationMs(junk)).toBeUndefined();
  });

  it("rejects with the signal's reason on abort and not a ProviderError", async () => {
    // Hangs until the SDK's request signal fires, as a socket that never answers would.
    fake.script(
      (init) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error)),
        ),
    );
    const controller = new AbortController();
    const reason = new Error('fenced: epoch 3 is stale');

    const { turn } = complete(REQUEST, controller.signal);
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    controller.abort(reason);

    await expect(turn).rejects.toBe(reason);
    await expect(turn).rejects.not.toBeInstanceOf(ProviderError);
  });

  describe('verify', () => {
    it('200 on GET /v1/models is ok, the key travelling as a bearer', async () => {
      fake.json(200, { object: 'list', data: [] });

      await expect(provider.verify(CREDENTIAL.apiKey)).resolves.toBe('ok');

      const [request] = fake.requests;
      expect(request!.method).toBe('GET');
      expect(request!.url).toBe('http://fake.local/v1/models');
      expect(request!.headers.authorization).toBe(`Bearer ${CREDENTIAL.apiKey}`);
    });

    it('401 is rejected', async () => {
      fake.json(401, { error: { type: 'invalid_request_error', message: 'bad key' } });

      await expect(provider.verify(CREDENTIAL.apiKey)).resolves.toBe('rejected');
    });

    it('500 and a refused connection are unreachable', async () => {
      fake.json(500, { error: { type: 'server_error', message: 'nope' } });
      await expect(provider.verify(CREDENTIAL.apiKey)).resolves.toBe('unreachable');

      fake.script(() => Promise.reject(new TypeError('fetch failed')));
      await expect(provider.verify(CREDENTIAL.apiKey)).resolves.toBe('unreachable');
    });
  });

  describe('BYOS bearer form (032 R9)', () => {
    const TOKEN = 'byos-openai-access-token-eeeeeeee';
    const BYOS: CredentialContext = {
      mode: 'BYOS',
      provider: 'openai',
      apiKey: TOKEN,
      accountLabel: 'ada@example.com',
      endpoint: { baseURL: 'https://sub.example.test/backend', headers: { 'x-profile': 'sub' } },
    };

    it('sends the token as a bearer to the endpoint base URL with its headers', async () => {
      fake.sse([
        terminal('response.completed', [
          { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
        ]),
      ]);

      await provider
        .client(BYOS, 'gpt-5')
        .complete(REQUEST, { onDelta: vi.fn(), signal: new AbortController().signal });

      const [request] = fake.requests;
      expect(request!.url).toBe('https://sub.example.test/backend/responses');
      expect(request!.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request!.headers['x-profile']).toBe('sub');
    });

    it('refuses a BYOS credential without an endpoint', () => {
      expect(() =>
        provider.client({ mode: 'BYOS', provider: 'openai', apiKey: TOKEN }, 'gpt-5'),
      ).toThrow(/endpoint/);
    });

    describe('verifyBearer', () => {
      it('200 on GET <endpoint>/models is ok, sent as a bearer', async () => {
        fake.json(200, { object: 'list', data: [] });

        await expect(provider.verifyBearer(BYOS)).resolves.toBe('ok');

        const [request] = fake.requests;
        expect(request!.method).toBe('GET');
        expect(request!.url).toBe('https://sub.example.test/backend/models');
        expect(request!.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(request!.headers['x-profile']).toBe('sub');
      });

      it('401 is rejected', async () => {
        fake.json(401, { error: { type: 'invalid_request_error', message: 'bad' } });
        await expect(provider.verifyBearer(BYOS)).resolves.toBe('rejected');
      });

      it('500, 429 and a refused connection are unreachable', async () => {
        fake.json(500, { error: { type: 'server_error', message: 'nope' } });
        await expect(provider.verifyBearer(BYOS)).resolves.toBe('unreachable');
        fake.json(429, { error: { type: 'rate_limit_error', message: 'slow' } });
        await expect(provider.verifyBearer(BYOS)).resolves.toBe('unreachable');
        fake.script(() => Promise.reject(new TypeError('fetch failed')));
        await expect(provider.verifyBearer(BYOS)).resolves.toBe('unreachable');
        expect(fake.requests).toHaveLength(3);
      });
    });
  });
});
