import { MODEL_CATALOGUE } from '@repo/contracts';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import './support/developer-dotenv';
import { AnthropicProvider } from '../src/modules/agent/anthropic.adapter';
import type {
  KeyVerifier,
  LlmProvider,
  LlmProviderName,
} from '../src/modules/agent/llm-provider.port';
import { OpenAiProvider } from '../src/modules/agent/openai.adapter';

/**
 * 020 T041 / SC-011's real walk: the shipped adapters against each provider's real API. It spends
 * (a few) tokens, so it is gated per provider on a test-only variable — `BYOK_REAL_ANTHROPIC_KEY`
 * / `BYOK_REAL_OPENAI_KEY`, deliberately absent from `environment.ts` so a production process can
 * never carry one — and only ever run by hand (quickstart.md § Real walk). The banner follows
 * `agent-real.e2e-spec.ts`: one line on stderr per provider skipped, distinct from `SKIPPING`.
 */

const REAL_TIMEOUT_MS = 60_000;
// Test-only too: an OpenAI-compatible endpoint to walk instead of api.openai.com.
const OPENAI_BASE_URL = process.env.BYOK_REAL_OPENAI_BASE_URL;

interface Walk {
  readonly adapter: LlmProvider & KeyVerifier;
  readonly key: string | undefined;
  readonly model: string;
  readonly provider: LlmProviderName;
  readonly skipBanner: string;
}

const WALKS: readonly Walk[] = [
  {
    adapter: new AnthropicProvider(),
    key: process.env.BYOK_REAL_ANTHROPIC_KEY,
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    skipBanner: 'ANTHROPIC-SKIP "byok-real": BYOK_REAL_ANTHROPIC_KEY not set',
  },
  {
    adapter: new OpenAiProvider({ baseURL: OPENAI_BASE_URL }),
    key: process.env.BYOK_REAL_OPENAI_KEY,
    model: 'gpt-5-mini',
    provider: 'openai',
    skipBanner: 'OPENAI-SKIP "byok-real": BYOK_REAL_OPENAI_KEY not set',
  },
];

for (const walk of WALKS) {
  if (!walk.key) process.stderr.write(`${walk.skipBanner}\n`);
}
if (process.env.BYOK_REAL_OPENAI_KEY) {
  process.stderr.write(
    `byok-real openai baseURL=${OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}\n`,
  );
}

describe('BYOK against the real providers (e2e)', () => {
  describe.each(WALKS)('$provider', (walk) => {
    describe.skipIf(!walk.key)('with a real key', () => {
      it(
        'verify answers ok',
        async () => {
          await expect(walk.adapter.verify(walk.key!)).resolves.toBe('ok');
        },
        REAL_TIMEOUT_MS,
      );

      it(
        'a one-turn prompt answers text with non-zero usage',
        async () => {
          const deltas: string[] = [];
          const turn = await walk.adapter
            .client({ apiKey: walk.key!, mode: 'BYOK', provider: walk.provider }, walk.model)
            .complete(
              {
                messages: [{ content: 'Reply with the single word: pong', role: 'user' }],
                system: 'You are a terse assistant.',
                tools: [],
              },
              {
                onDelta: (delta) => {
                  if (delta.kind === 'text') deltas.push(delta.text);
                },
                signal: new AbortController().signal,
              },
            );

          expect(turn.stop).toBe('end_turn');
          expect(turn.text.trim().length).toBeGreaterThan(0);
          expect(deltas.join('')).toBe(turn.text);
          expect(turn.usage.inputTokens).toBeGreaterThan(0);
          expect(turn.usage.outputTokens).toBeGreaterThan(0);

          // Paste into the spec's matrix row — never the key, only the totals.
          process.stdout.write(
            `byok-real ${walk.provider} ${walk.model}: inputTokens=${turn.usage.inputTokens} outputTokens=${turn.usage.outputTokens}\n`,
          );
        },
        REAL_TIMEOUT_MS,
      );

      it(
        'a deliberately wrong key answers rejected',
        async () => {
          await expect(walk.adapter.verify(`${walk.key!.slice(0, -6)}WRONG0`)).resolves.toBe(
            'rejected',
          );
        },
        REAL_TIMEOUT_MS,
      );
    });
  });

  // T048's input: the curated ids are a promise the provider must keep, checked against the list
  // the key can actually see. Anthropic's catalogue is 011's and already walked by agent-real.
  describe.skipIf(!process.env.BYOK_REAL_OPENAI_KEY)('openai models.list()', () => {
    it(
      'carries every curated OpenAI id',
      async () => {
        const client = new OpenAI({
          apiKey: process.env.BYOK_REAL_OPENAI_KEY,
          baseURL: OPENAI_BASE_URL,
          maxRetries: 0,
        });
        const listed = new Set<string>();
        for await (const model of client.models.list()) listed.add(model.id);
        process.stdout.write(`byok-real openai models.list(): ${[...listed].sort().join(', ')}\n`);

        const curated = MODEL_CATALOGUE.filter((model) => model.provider === 'openai').map(
          (model) => model.id,
        );
        expect(curated.length).toBeGreaterThan(0);
        for (const id of curated) expect(listed, `${id} missing from models.list()`).toContain(id);
      },
      REAL_TIMEOUT_MS,
    );
  });
});
