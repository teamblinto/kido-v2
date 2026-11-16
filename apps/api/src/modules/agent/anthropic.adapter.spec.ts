import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type FakeAnthropic,
  type Script,
  startFakeAnthropic,
} from '../../../test/support/fake-anthropic';
import { MAX_OUTPUT_TOKENS } from './agent.constants';
import { AnthropicProvider, withRateLimitReset } from './anthropic.adapter';
import type { CredentialContext, Delta, ModelRequest } from './llm-provider.port';
import { ProviderError, type ProviderFailureClass } from './provider-error';
import { toInputSchema } from './tool-schema';

const CREDENTIAL: CredentialContext = {
  mode: 'BYOK',
  provider: 'anthropic',
  apiKey: 'sk-ant-test-key-aaaaaaaa',
};
const MODEL = 'claude-opus-5';

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
      // `z.toJSONSchema` of a union: a root `anyOf`, no root `type`.
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
      toolCalls: [{ id: 'toolu_1', name: 'fs_read', input: { path: 'README.md' } }],
    },
    { role: 'tool', results: [{ toolUseId: 'toolu_1', content: '# hi', isError: false }] },
  ],
};

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * The adapter against the loopback fake (research R1/R2): the real SDK, its real SSE parser and
 * accumulator, over a real socket. The body log is the proof of FR-005/006 — what was sent, and
 * nothing else.
 */
describe('AnthropicProvider', () => {
  let fake: FakeAnthropic;
  let provider: AnthropicProvider;

  beforeEach(async () => {
    fake = startFakeAnthropic();
    await fake.start();
    provider = new AnthropicProvider({ baseURL: fake.baseURL });
  });

  afterEach(() => fake.close());

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

  it('constructs one SDK client per client() call with maxRetries 0', async () => {
    fake.script({ reply: { text: 'a', usage: USAGE, stopReason: 'end_turn' } });
    fake.script({ reply: { text: 'b', usage: USAGE, stopReason: 'end_turn' } });
    const hooks = { onDelta: vi.fn(), signal: new AbortController().signal };

    await provider.client(CREDENTIAL, MODEL).complete(REQUEST, hooks);
    await provider
      .client({ ...CREDENTIAL, apiKey: 'sk-ant-other-key-bbbbbbbb' }, MODEL)
      .complete(REQUEST, hooks);

    expect(fake.requests.map((request) => request.headers['x-api-key'])).toEqual([
      CREDENTIAL.apiKey,
      'sk-ant-other-key-bbbbbbbb',
    ]);

    // A retryable status and exactly one request on the wire: the SDK's own retries are off.
    fake.script({ status: 500, body: { type: 'error', error: { type: 'api_error' } } });
    await expect(provider.client(CREDENTIAL, MODEL).complete(REQUEST, hooks)).rejects.toThrow();
    expect(fake.requests).toHaveLength(3);
  });

  it('sends system as one cached block, then tools with eager_input_streaming, then messages, and nothing else', async () => {
    fake.script({ reply: { text: 'ok', usage: USAGE, stopReason: 'end_turn' } });

    await complete().turn;

    const body = lastBody();
    expect(Object.keys(body)).toEqual([
      'model',
      'max_tokens',
      'system',
      'tools',
      'messages',
      'stream',
    ]);
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(body.stream).toBe(true);
    expect(body.system).toEqual([
      { type: 'text', text: REQUEST.system, cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.tools).toEqual([
      {
        name: 'fs_read',
        description: 'Read a file.',
        input_schema: REQUEST.tools[0]!.inputSchema,
        eager_input_streaming: true,
      },
      {
        name: 'fs_edit',
        description: 'Edit a file.',
        // Flattened by `toInputSchema` (tool-schema.spec.ts has the cases); the adapter must use it.
        input_schema: toInputSchema(REQUEST.tools[1]!.inputSchema),
        eager_input_streaming: true,
      },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: 'read README' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'toolu_1', name: 'fs_read', input: { path: 'README.md' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '# hi', is_error: false },
        ],
      },
    ]);
    expect(body).not.toHaveProperty('metadata');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
  });

  it('forwards text deltas in order as they arrive', async () => {
    fake.script({
      reply: { text: ['Hel', 'lo, ', 'world'], usage: USAGE, stopReason: 'end_turn' },
    });
    const seenBeforeResolve: string[] = [];
    let resolved = false;

    const turn = provider.client(CREDENTIAL, MODEL).complete(REQUEST, {
      onDelta: (delta) => {
        if (!resolved) seenBeforeResolve.push(delta.text);
      },
      signal: new AbortController().signal,
    });
    const result = await turn;
    resolved = true;

    expect(seenBeforeResolve).toEqual(['Hel', 'lo, ', 'world']);
    expect(result.text).toBe('Hello, world');
  });

  it('forwards thinking deltas as thinking', async () => {
    fake.script({
      reply: { thinking: ['plan ', 'first'], text: 'go', usage: USAGE, stopReason: 'end_turn' },
    });

    const { deltas, turn } = complete();
    const result = await turn;

    expect(deltas.filter((delta) => delta.kind === 'thinking')).toEqual([
      { kind: 'thinking', text: 'plan ' },
      { kind: 'thinking', text: 'first' },
    ]);
    expect(result.text).toBe('go');
  });

  it('drops thinking deltas with empty text', async () => {
    fake.script({
      reply: { thinking: ['', 'kept', ''], text: 'go', usage: USAGE, stopReason: 'end_turn' },
    });

    const { deltas, turn } = complete();
    await turn;

    expect(deltas).toEqual([
      { kind: 'thinking', text: 'kept' },
      { kind: 'text', text: 'go' },
    ]);
  });

  it('assembles tool_use blocks from fragmented input_json_delta', async () => {
    fake.script({
      reply: {
        text: 'Let me look.',
        toolUse: [
          { id: 'toolu_1', name: 'fs_read', input: { path: 'src/index.ts' } },
          { id: 'toolu_2', name: 'exec', input: { command: 'pnpm test --filter "@repo/api"' } },
        ],
        usage: USAGE,
        stopReason: 'tool_use',
      },
    });

    const result = await complete().turn;

    expect(result.text).toBe('Let me look.');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'fs_read', input: { path: 'src/index.ts' } },
      { id: 'toolu_2', name: 'exec', input: { command: 'pnpm test --filter "@repo/api"' } },
    ]);
    expect(result.stop).toBe('tool_use');
  });

  it('SC-5: sends attachments as image, document and text blocks before the words; none keeps a string', async () => {
    fake.script({ reply: { text: 'ok', usage: USAGE, stopReason: 'end_turn' } });
    const png = Buffer.from('png-bytes');
    const pdf = Buffer.from('%PDF-1.7');

    await complete({
      ...REQUEST,
      messages: [
        {
          role: 'user',
          content: 'use these',
          attachments: [
            {
              kind: 'image',
              mimeType: 'image/png',
              name: 'logo.png',
              data: png,
              workspacePath: '.git/kido-attachments/a1/logo.png',
            },
            { kind: 'pdf', mimeType: 'application/pdf', name: 'spec.pdf', data: pdf },
            { kind: 'text', mimeType: 'text/csv', name: 'data.csv', text: 'a,b' },
          ],
        },
        { role: 'user', content: 'plain' },
      ],
    }).turn;

    expect(lastBody().messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
          },
          {
            type: 'text',
            text: '<attachment name="logo.png" kind="image" path=".git/kido-attachments/a1/logo.png" />',
          },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
          },
          { type: 'text', text: '<attachment name="spec.pdf" kind="pdf" />' },
          { type: 'text', text: '<attachment name="data.csv" kind="text">\na,b\n</attachment>' },
          { type: 'text', text: 'use these' },
        ],
      },
      { role: 'user', content: 'plain' },
    ]);
  });

  it('sends system and map as two system blocks, both with cache_control', async () => {
    fake.script({ reply: { text: 'ok', usage: USAGE, stopReason: 'end_turn' } });

    await complete({ ...REQUEST, context: { map: 'src/\n  index.ts', excerpts: '' } }).turn;

    expect(lastBody().system).toEqual([
      { type: 'text', text: REQUEST.system, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'src/\n  index.ts', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('omits an empty map or excerpts block and keeps cache_control on what remains', async () => {
    fake.script({ reply: { text: 'ok', usage: USAGE, stopReason: 'end_turn' } });
    fake.script({ reply: { text: 'ok', usage: USAGE, stopReason: 'end_turn' } });

    await complete({ ...REQUEST, context: { map: '', excerpts: '' } }).turn;
    expect(lastBody().system).toEqual([
      { type: 'text', text: REQUEST.system, cache_control: { type: 'ephemeral' } },
    ]);

    await complete({ ...REQUEST, context: { map: '', excerpts: 'README.md:1 # hi' } }).turn;
    expect(lastBody().system).toEqual([
      { type: 'text', text: REQUEST.system, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'README.md:1 # hi' },
    ]);
  });

  it('sends a non-empty excerpts block third, without cache_control', async () => {
    fake.script({ reply: { text: 'ok', usage: USAGE, stopReason: 'end_turn' } });

    await complete({ ...REQUEST, context: { map: 'src/', excerpts: 'README.md:1 # hi' } }).turn;

    expect(lastBody().system).toEqual([
      { type: 'text', text: REQUEST.system, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'src/', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'README.md:1 # hi' },
    ]);
  });

  it('reports cache_read and cache_creation tokens separately and no longer folds them into inputTokens', async () => {
    fake.script({
      reply: {
        text: 'ok',
        usage: {
          inputTokens: 100,
          outputTokens: 7,
          cacheReadInputTokens: 2_000,
          cacheCreationInputTokens: 300,
        },
        stopReason: 'end_turn',
      },
    });

    const result = await complete().turn;

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 7,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 300,
    });
  });

  it('reports stop end_turn / tool_use / max_tokens', async () => {
    for (const stopReason of ['end_turn', 'tool_use', 'max_tokens'] as const) {
      fake.script({ reply: { text: 'x', usage: USAGE, stopReason } });
      expect((await complete().turn).stop).toBe(stopReason);
    }
  });

  it('holds no client or key on the provider instance', async () => {
    fake.script({ reply: { text: 'ok', usage: USAGE, stopReason: 'end_turn' } });

    await complete().turn;

    const values = Object.values(provider as unknown as Record<string, unknown>);
    expect(values).not.toContain(CREDENTIAL.apiKey);
    expect(values.some((value) => value instanceof Anthropic)).toBe(false);
  });

  it('ignores ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in the environment', async () => {
    const saved = {
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    };
    // A dead port and a bearer token nobody declared: neither may steer where the key goes.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    process.env.ANTHROPIC_AUTH_TOKEN = 'SENTINEL-auth-token-2b7e';
    try {
      fake.script({ reply: { text: 'ok', usage: USAGE, stopReason: 'end_turn' } });

      await new AnthropicProvider({ baseURL: fake.baseURL })
        .client(CREDENTIAL, MODEL)
        .complete(REQUEST, { onDelta: vi.fn(), signal: new AbortController().signal });

      expect(fake.requests).toHaveLength(1);
      const { headers } = fake.requests[0]!;
      expect(headers['x-api-key']).toBe(CREDENTIAL.apiKey);
      expect(headers).not.toHaveProperty('authorization');
      expect(JSON.stringify(headers)).not.toContain('SENTINEL-auth-token-2b7e');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('defaults the base URL to api.anthropic.com when the transport names none', async () => {
    const saved = process.env.ANTHROPIC_BASE_URL;
    // Without the adapter's own default the SDK would read this one.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    const urls: string[] = [];
    const capture: typeof globalThis.fetch = (input) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Promise.reject(new Error('captured; no socket'));
    };
    try {
      await expect(
        new AnthropicProvider({ fetch: capture })
          .client(CREDENTIAL, MODEL)
          .complete(REQUEST, { onDelta: vi.fn(), signal: new AbortController().signal }),
      ).rejects.toThrow();

      expect(urls).toHaveLength(1);
      expect(new URL(urls[0]!).host).toBe('api.anthropic.com');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved;
    }
  });

  it("rejects with the signal's reason on abort and not a ProviderError", async () => {
    fake.script({ hang: true });
    const controller = new AbortController();
    const reason = new Error('fenced: epoch 3 is stale');

    const { turn } = complete(REQUEST, controller.signal);
    turn.catch(() => undefined);
    // The fake has answered the headers once the request is logged; abort mid-stream.
    await new Promise<void>((resolve) => {
      const poll = () => (fake.requests.length > 0 ? resolve() : setTimeout(poll, 5));
      poll();
    });
    controller.abort(reason);

    await expect(turn).rejects.toBe(reason);
    await expect(turn).rejects.not.toBeInstanceOf(ProviderError);
  });
  describe('verify (020 R4)', () => {
    const KEY = 'sk-ant-verify-key-cccccccc';

    /** A fetch double: logs every request and answers with `reply`; no socket. */
    function transport(reply: () => Response | Promise<Response>) {
      const seen: { url: string; method: string; headers: Record<string, string>; body: string }[] =
        [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        seen.push({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
        });
        return reply();
      };
      return { fetch, seen };
    }

    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    it('200 on GET /v1/models?limit=1 is ok, and the key travels only in x-api-key', async () => {
      const { fetch, seen } = transport(() =>
        json(200, { data: [{ id: MODEL, type: 'model' }], has_more: false }),
      );

      await expect(new AnthropicProvider({ fetch }).verify(KEY)).resolves.toBe('ok');

      expect(seen).toHaveLength(1);
      const { url, method, headers, body } = seen[0]!;
      expect(method).toBe('GET');
      const parsed = new URL(url);
      expect(parsed.host).toBe('api.anthropic.com');
      expect(parsed.pathname).toBe('/v1/models');
      expect(parsed.searchParams.get('limit')).toBe('1');
      expect(headers['x-api-key']).toBe(KEY);
      expect(url).not.toContain(KEY);
      expect(body).not.toContain(KEY);
      const others = Object.entries(headers).filter(([name]) => name !== 'x-api-key');
      expect(JSON.stringify(others)).not.toContain(KEY);
      expect(headers).not.toHaveProperty('authorization');
    });

    it('401 is rejected', async () => {
      const { fetch } = transport(() =>
        json(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }),
      );

      await expect(new AnthropicProvider({ fetch }).verify(KEY)).resolves.toBe('rejected');
    });

    it.each([
      ['connection refused', () => Promise.reject(new TypeError('fetch failed'))],
      ['500', () => json(500, { type: 'error', error: { type: 'api_error', message: 'x' } })],
      [
        '429',
        () => json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }),
      ],
    ] as const)('%s is unreachable, after exactly one request', async (_name, reply) => {
      const { fetch, seen } = transport(reply);

      await expect(new AnthropicProvider({ fetch }).verify(KEY)).resolves.toBe('unreachable');
      expect(seen).toHaveLength(1);
    });
  });

  describe('BYOS bearer form (032 R9)', () => {
    const TOKEN = 'sk-ant-oat01-byos-access-token-dddddddd';

    function byos(baseURL: string): CredentialContext {
      return {
        mode: 'BYOS',
        provider: 'anthropic',
        apiKey: TOKEN,
        accountLabel: 'ada@example.com',
        endpoint: {
          baseURL,
          headers: { 'anthropic-beta': 'oauth-2025-04-20', 'x-profile': 'sub' },
        },
      };
    }

    it('sends Authorization: Bearer, no x-api-key, to the endpoint base URL with its headers', async () => {
      // The provider's own transport points elsewhere: the endpoint must win for BYOS.
      const elsewhere = new AnthropicProvider({ baseURL: 'http://127.0.0.1:1' });
      fake.script({ reply: { text: 'ok', usage: USAGE, stopReason: 'end_turn' } });

      await elsewhere
        .client(byos(fake.baseURL), MODEL)
        .complete(REQUEST, { onDelta: vi.fn(), signal: new AbortController().signal });

      const { headers } = fake.requests.at(-1)!;
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers).not.toHaveProperty('x-api-key');
      expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
      expect(headers['x-profile']).toBe('sub');
    });

    it('an organisation key still travels in x-api-key only', async () => {
      fake.script({ reply: { text: 'ok', usage: USAGE, stopReason: 'end_turn' } });

      await complete().turn;

      const { headers } = fake.requests.at(-1)!;
      expect(headers['x-api-key']).toBe(CREDENTIAL.apiKey);
      expect(headers).not.toHaveProperty('authorization');
    });

    it('refuses a BYOS credential without an endpoint rather than guessing one', () => {
      expect(() =>
        provider.client({ mode: 'BYOS', provider: 'anthropic', apiKey: TOKEN }, MODEL),
      ).toThrow(/endpoint/);
    });

    describe('verifyBearer', () => {
      function transport(reply: () => Response | Promise<Response>) {
        const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const request = new Request(input, init);
          seen.push({
            url: request.url,
            method: request.method,
            headers: Object.fromEntries(request.headers),
          });
          return reply();
        };
        return { fetch, seen };
      }
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      it('200 on GET <endpoint>/v1/models?limit=1 is ok, sent as a bearer', async () => {
        const { fetch, seen } = transport(() => json(200, { data: [], has_more: false }));

        await expect(
          new AnthropicProvider({ fetch }).verifyBearer(byos('https://sub.example.test')),
        ).resolves.toBe('ok');

        expect(seen).toHaveLength(1);
        const parsed = new URL(seen[0]!.url);
        expect(parsed.host).toBe('sub.example.test');
        expect(parsed.pathname).toBe('/v1/models');
        expect(parsed.searchParams.get('limit')).toBe('1');
        expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(seen[0]!.headers).not.toHaveProperty('x-api-key');
        expect(seen[0]!.headers['x-profile']).toBe('sub');
      });

      it('401 is rejected', async () => {
        const { fetch } = transport(() =>
          json(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }),
        );
        await expect(
          new AnthropicProvider({ fetch }).verifyBearer(byos('https://sub.example.test')),
        ).resolves.toBe('rejected');
      });

      it.each([
        ['connection refused', () => Promise.reject(new TypeError('fetch failed'))],
        ['500', () => json(500, { type: 'error', error: { type: 'api_error', message: 'x' } })],
        [
          '429',
          () => json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }),
        ],
      ] as const)('%s is unreachable, after exactly one request', async (_name, reply) => {
        const { fetch, seen } = transport(reply);
        await expect(
          new AnthropicProvider({ fetch }).verifyBearer(byos('https://sub.example.test')),
        ).resolves.toBe('unreachable');
        expect(seen).toHaveLength(1);
      });
    });
  });

  describe('failures', () => {
    const SENTINEL = 'SENTINEL-body-7f3a9c';
    const errorBody = (type: string, message = 'nope') => ({
      type: 'error',
      error: { type, message: `${message} ${SENTINEL}` },
    });

    const FAILURES: readonly {
      readonly name: string;
      readonly script: Script;
      readonly expected: ProviderFailureClass;
      readonly transient: boolean;
      /** A client-side timeout on the transport's fetch, for a stream that never ends. */
      readonly timeoutMs?: number;
    }[] = [
      {
        name: '401',
        script: { status: 401, body: errorBody('authentication_error') },
        expected: 'unauthorised',
        transient: false,
      },
      {
        name: '403',
        script: { status: 403, body: errorBody('permission_error') },
        expected: 'unauthorised',
        transient: false,
      },
      {
        name: '429 with retry-after',
        script: {
          status: 429,
          body: errorBody('rate_limit_error'),
          headers: { 'retry-after': '7' },
        },
        expected: 'rate-limited',
        transient: true,
      },
      {
        name: '529 overloaded_error',
        script: { status: 529, body: errorBody('overloaded_error') },
        expected: 'overloaded',
        transient: true,
      },
      {
        name: '500',
        script: { status: 500, body: errorBody('api_error') },
        expected: 'unavailable',
        transient: true,
      },
      {
        name: '400',
        script: { status: 400, body: errorBody('invalid_request_error') },
        expected: 'rejected',
        transient: false,
      },
      {
        name: '400 context',
        script: {
          status: 400,
          body: errorBody(
            'invalid_request_error',
            'prompt is too long: 250000 tokens > 200000 maximum',
          ),
        },
        expected: 'context-too-long',
        transient: false,
      },
      {
        name: '404',
        script: { status: 404, body: errorBody('not_found_error') },
        expected: 'rejected',
        transient: false,
      },
      {
        name: 'dropMidStream',
        script: { dropMidStream: true },
        expected: 'connection-lost',
        transient: true,
      },
      {
        name: 'hang + client timeout',
        script: { hang: true },
        expected: 'timeout',
        transient: true,
        timeoutMs: 50,
      },
    ];

    it.each(FAILURES)('$name → $expected', async ({ script, expected, transient, timeoutMs }) => {
      fake.script(script);
      if (timeoutMs !== undefined) {
        provider = new AnthropicProvider({
          baseURL: fake.baseURL,
          fetch: (url, init) =>
            globalThis.fetch(url, {
              ...init,
              signal: AbortSignal.any([init!.signal!, AbortSignal.timeout(timeoutMs)]),
            }),
        });
      }

      const { turn } = complete();
      const error: unknown = await turn.then(
        () => 'resolved',
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).class).toBe(expected);
      expect((error as ProviderError).transient).toBe(transient);
      expect((error as ProviderError).message).toBe(expected);
    });

    it('429 without retry-after waits for the latest anthropic-ratelimit-*-reset (032 T057)', async () => {
      fake.script({
        status: 429,
        body: errorBody('rate_limit_error'),
        headers: {
          'anthropic-ratelimit-requests-reset': new Date(Date.now() + 5_000).toISOString(),
          'anthropic-ratelimit-tokens-reset': new Date(Date.now() + 60_000).toISOString(),
        },
      });

      const error = (await complete().turn.catch((e: unknown) => e)) as ProviderError;

      expect(error.class).toBe('rate-limited');
      expect(error.retryAfterMs).toBeGreaterThan(55_000);
      expect(error.retryAfterMs).toBeLessThanOrEqual(60_000);
    });

    it('withRateLimitReset keeps retry-after, and ignores past or unreadable instants', () => {
      const now = Date.parse('2026-01-01T00:00:00Z');
      const withHeaders = (headers: Record<string, string>) => ({
        headers: { get: (name: string) => headers[name] ?? null },
      });
      const reset = { 'anthropic-ratelimit-tokens-reset': '2026-01-01T00:00:30Z' };

      const told = new ProviderError('rate-limited', { retryAfterMs: 7_000 });
      expect(withRateLimitReset(told, withHeaders(reset), now)).toBe(told);
      expect(
        withRateLimitReset(new ProviderError('rate-limited'), withHeaders(reset), now).retryAfterMs,
      ).toBe(30_000);
      expect(
        withRateLimitReset(
          new ProviderError('rate-limited'),
          withHeaders({
            'anthropic-ratelimit-requests-remaining': '0',
            'anthropic-ratelimit-requests-reset': '2026-01-01T00:00:02Z',
            'anthropic-ratelimit-tokens-remaining': '5000',
            'anthropic-ratelimit-tokens-reset': '2026-01-01T00:05:00Z',
          }),
          now,
        ).retryAfterMs,
      ).toBe(2_000);
      for (const value of ['2025-12-31T23:59:00Z', 'soon']) {
        const bare = new ProviderError('rate-limited');
        expect(
          withRateLimitReset(
            bare,
            withHeaders({ 'anthropic-ratelimit-requests-reset': value }),
            now,
          ),
        ).toBe(bare);
      }
    });

    it("no byte of the fake's body reaches the error or the log", async () => {
      fake.script({
        status: 401,
        body: errorBody('authentication_error'),
        headers: { 'request-id': 'req_fake_0001' },
      });
      const written: string[] = [];
      const capture = (chunk: Uint8Array | string): boolean => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      };
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);

      let error: unknown;
      try {
        error = await complete().turn.then(
          () => 'resolved',
          (e: unknown) => e,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        out.mockRestore();
        err.mockRestore();
      }

      expect(error).toBeInstanceOf(ProviderError);
      const provider = error as ProviderError;
      expect(provider.requestId).toBe('req_fake_0001');
      expect(provider.status).toBe(401);
      const flattened = [
        provider.message,
        ...Object.getOwnPropertyNames(provider).map((key) =>
          String((provider as unknown as Record<string, unknown>)[key]),
        ),
        JSON.stringify(provider),
        provider.stack ?? '',
      ].join('\n');
      expect(flattened).not.toContain(SENTINEL);
      expect(written.join('')).not.toContain(SENTINEL);
    });

    it('refusal stop reason is refused', async () => {
      fake.script({
        reply: { text: 'I cannot help with that.', usage: USAGE, stopReason: 'refusal' },
      });

      const error: unknown = await complete().turn.then(
        () => 'resolved',
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).class).toBe('refused');
      expect((error as ProviderError).transient).toBe(false);
    });
  });
});
