import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateDataEncryptionKey, revealDataEncryptionKey } from './branded';
import { KekUnwrapError, UnknownKekError } from './kek-provider.port';
import {
  type OpenBaoFetch,
  OpenBaoKekProvider,
  OpenBaoTransportError,
  TRANSIT_MOUNT,
} from './openbao-kek.provider';

const ADDR = 'https://openbao.internal:8200';
const TOKEN = 's.9c1f4b7ae2d38f60';
const KEY_NAME = 'forge-kek';
const ORG = '9f1c4d2e-6b8a-4f70-9c3d-1e5a7b2c8d40';

interface Call {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly url: string;
}

/** Records what the adapter sent and replies with whatever the test wants back. */
function transport(reply: (call: Call) => { body?: unknown; ok?: boolean; status?: number }) {
  const calls: Call[] = [];

  const fetch: OpenBaoFetch = (url, init) => {
    const call: Call = { body: JSON.parse(init.body), headers: init.headers, url };

    calls.push(call);

    const { body = {}, ok = true, status = 200 } = reply(call);

    return Promise.resolve({ json: () => Promise.resolve(body), ok, status });
  };

  return { calls, fetch };
}

/** A transit engine that really round-trips, so a wrap/unwrap pair can be asserted end to end. */
function fakeTransit() {
  const vault = new Map<string, { context: string; plaintext: string }>();
  let version = 0;

  return transport((call) => {
    const payload = call.body as { ciphertext?: string; context: string; plaintext?: string };

    if (call.url.includes('/encrypt/')) {
      version += 1;
      const ciphertext = `vault:v1:stored-${version}`;

      vault.set(ciphertext, { context: payload.context, plaintext: payload.plaintext! });

      return { body: { data: { ciphertext, key_version: 1 } } };
    }

    const stored = vault.get(payload.ciphertext!);

    // Transit derives the data key from the context, so a mismatched context cannot decrypt.
    if (stored?.context !== payload.context) {
      return { body: { errors: ['unable to decrypt'] }, ok: false, status: 400 };
    }

    return { body: { data: { plaintext: stored.plaintext } } };
  });
}

function provider(fetch: OpenBaoFetch): OpenBaoKekProvider {
  return new OpenBaoKekProvider({ addr: ADDR, fetch, keyName: KEY_NAME, token: TOKEN });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenBaoKekProvider.kekId', () => {
  it('names the provider and the transit key', () => {
    expect(provider(fakeTransit().fetch).kekId).toBe(`openbao:${KEY_NAME}`);
  });

  it('differs from an env provider id, so the two can never be confused in a row', () => {
    expect(provider(fakeTransit().fetch).kekId.startsWith('env:')).toBe(false);
  });
});

describe('OpenBaoKekProvider wrap', () => {
  it('returns the exact key it wrapped, through the transit engine', async () => {
    const kek = provider(fakeTransit().fetch);
    const dek = generateDataEncryptionKey();

    const unwrapped = await kek.unwrap(await kek.wrap(dek, { orgId: ORG }), { orgId: ORG });

    expect(revealDataEncryptionKey(unwrapped)).toEqual(revealDataEncryptionKey(dek));
  });

  it('posts to the transit encrypt endpoint for the configured key', async () => {
    const { calls, fetch } = fakeTransit();

    await provider(fetch).wrap(generateDataEncryptionKey(), { orgId: ORG });

    expect(calls[0]!.url).toBe(`${ADDR}/v1/${TRANSIT_MOUNT}/encrypt/${KEY_NAME}`);
  });

  it('authenticates with the vault token header rather than a query parameter', async () => {
    const { calls, fetch } = fakeTransit();

    await provider(fetch).wrap(generateDataEncryptionKey(), { orgId: ORG });

    expect(calls[0]!.headers['X-Vault-Token']).toBe(TOKEN);
    expect(calls[0]!.url).not.toContain(TOKEN);
  });

  /**
   * The organisation goes in transit's `context`, which is what makes the engine derive a distinct
   * data key per tenant. Binding it any other way would leave the tenant separation to us rather
   * than to the vault.
   */
  it('binds the organisation as the derivation context', async () => {
    const { calls, fetch } = fakeTransit();

    await provider(fetch).wrap(generateDataEncryptionKey(), { orgId: ORG });

    expect((calls[0]!.body as { context: string }).context).toBe(
      Buffer.from(ORG).toString('base64'),
    );
  });

  it('sends the key as base64, which is the only encoding transit accepts', async () => {
    const { calls, fetch } = fakeTransit();
    const dek = generateDataEncryptionKey();

    await provider(fetch).wrap(dek, { orgId: ORG });

    expect((calls[0]!.body as { plaintext: string }).plaintext).toBe(
      revealDataEncryptionKey(dek).toString('base64'),
    );
  });

  it('stamps the wrap with its own kek id', async () => {
    const kek = provider(fakeTransit().fetch);

    expect((await kek.wrap(generateDataEncryptionKey(), { orgId: ORG })).kekId).toBe(kek.kekId);
  });

  it('stores the transit ciphertext verbatim, so the vault can read its own key version', async () => {
    const wrapped = await provider(fakeTransit().fetch).wrap(generateDataEncryptionKey(), {
      orgId: ORG,
    });

    expect(wrapped.ciphertext.toString('utf8')).toMatch(/^vault:v1:/);
  });

  it('fails when the vault refuses the request', async () => {
    const { fetch } = transport(() => ({
      body: { errors: ['permission denied'] },
      ok: false,
      status: 403,
    }));

    await expect(provider(fetch).wrap(generateDataEncryptionKey(), { orgId: ORG })).rejects.toThrow(
      OpenBaoTransportError,
    );
  });

  it('fails when the vault answers 200 with a body that has no ciphertext', async () => {
    const { fetch } = transport(() => ({ body: { data: {} } }));

    await expect(provider(fetch).wrap(generateDataEncryptionKey(), { orgId: ORG })).rejects.toThrow(
      OpenBaoTransportError,
    );
  });

  it('fails when the vault answers 200 with no body at all', async () => {
    const { fetch } = transport(() => ({ body: null }));

    await expect(provider(fetch).wrap(generateDataEncryptionKey(), { orgId: ORG })).rejects.toThrow(
      OpenBaoTransportError,
    );
  });
});

describe('OpenBaoKekProvider unwrap', () => {
  it('posts to the transit decrypt endpoint', async () => {
    const { calls, fetch } = fakeTransit();
    const kek = provider(fetch);

    await kek.unwrap(await kek.wrap(generateDataEncryptionKey(), { orgId: ORG }), { orgId: ORG });

    expect(calls[1]!.url).toBe(`${ADDR}/v1/${TRANSIT_MOUNT}/decrypt/${KEY_NAME}`);
  });

  it('refuses a wrap presented under another organisation', async () => {
    const kek = provider(fakeTransit().fetch);
    const wrapped = await kek.wrap(generateDataEncryptionKey(), { orgId: ORG });

    await expect(
      kek.unwrap(wrapped, { orgId: 'c2a7f019-4d3b-4a62-8e15-73b904ca6f88' }),
    ).rejects.toThrow(KekUnwrapError);
  });

  it('refuses a wrap that names a different KEK', async () => {
    const kek = provider(fakeTransit().fetch);

    await expect(
      kek.unwrap({ ciphertext: Buffer.from('vault:v1:x'), kekId: 'openbao:other' }, { orgId: ORG }),
    ).rejects.toThrow(UnknownKekError);
  });

  /**
   * A vault that is unreachable, out of quota or newly unauthorised must not be reported as a
   * ciphertext that failed to authenticate. The two call for opposite responses — page an operator
   * versus treat the row as unreadable — so they get different error types. Transit answers a
   * genuine decrypt refusal with 400, which is the one that becomes a `KekUnwrapError`.
   */
  it.each([403, 500, 503])('reports a %i from the vault as a transport failure', async (status) => {
    const { fetch } = transport(() => ({ ok: false, status }));

    await expect(
      provider(fetch).unwrap(
        { ciphertext: Buffer.from('vault:v1:x'), kekId: `openbao:${KEY_NAME}` },
        { orgId: ORG },
      ),
    ).rejects.toThrow(OpenBaoTransportError);
  });

  it('reports a 200 with no plaintext as a transport failure, not a bad ciphertext', async () => {
    const { fetch } = transport(() => ({ body: { data: {} } }));

    await expect(
      provider(fetch).unwrap(
        { ciphertext: Buffer.from('vault:v1:x'), kekId: `openbao:${KEY_NAME}` },
        { orgId: ORG },
      ),
    ).rejects.toThrow(OpenBaoTransportError);
  });

  it('fails when the vault returns a plaintext that is not a 32-byte key', async () => {
    const { fetch } = transport(() => ({
      body: { data: { plaintext: Buffer.from('short').toString('base64') } },
    }));

    await expect(
      provider(fetch).unwrap(
        { ciphertext: Buffer.from('vault:v1:x'), kekId: `openbao:${KEY_NAME}` },
        { orgId: ORG },
      ),
    ).rejects.toThrow(KekUnwrapError);
  });
});

describe('OpenBaoKekProvider failures', () => {
  /** These reach a log and an error tracker; the token in particular is a bearer credential. */
  it('names neither the token nor the key material', async () => {
    const kek = provider(fakeTransit().fetch);
    const dek = generateDataEncryptionKey();
    const wrapped = await kek.wrap(dek, { orgId: ORG });
    let caught: unknown;

    try {
      await kek.unwrap(wrapped, { orgId: 'c2a7f019-4d3b-4a62-8e15-73b904ca6f88' });
    } catch (error) {
      caught = error;
    }

    const rendered = `${(caught as Error).message} ${(caught as Error).stack ?? ''}`;

    expect(rendered).not.toContain(TOKEN);
    expect(rendered).not.toContain(revealDataEncryptionKey(dek).toString('base64'));
  });

  it('reports the status so an operator can tell a 403 from a 503', async () => {
    const { fetch } = transport(() => ({ ok: false, status: 503 }));

    await expect(provider(fetch).wrap(generateDataEncryptionKey(), { orgId: ORG })).rejects.toThrow(
      /503/,
    );
  });

  it('surfaces a transport failure rather than swallowing it', async () => {
    const fetch: OpenBaoFetch = () => Promise.reject(new Error('ECONNREFUSED'));

    await expect(provider(fetch).wrap(generateDataEncryptionKey(), { orgId: ORG })).rejects.toThrow(
      OpenBaoTransportError,
    );
  });
});

describe('OpenBaoKekProvider transport', () => {
  /**
   * The adapter ships unwired (ADR 003), so nothing in the application supplies a transport today.
   * The default has to be the platform one, and it has to be reached lazily — a module-level
   * reference would capture whatever `fetch` was at import time.
   */
  it('falls back to the global fetch when none is injected', async () => {
    const called: string[] = [];

    vi.stubGlobal('fetch', (url: string) => {
      called.push(url);

      return Promise.resolve({
        json: () => Promise.resolve({ data: { ciphertext: 'vault:v1:global' } }),
        ok: true,
        status: 200,
      });
    });

    const kek = new OpenBaoKekProvider({ addr: ADDR, keyName: KEY_NAME, token: TOKEN });
    const wrapped = await kek.wrap(generateDataEncryptionKey(), { orgId: ORG });

    expect(called).toEqual([`${ADDR}/v1/${TRANSIT_MOUNT}/encrypt/${KEY_NAME}`]);
    expect(wrapped.ciphertext.toString('utf8')).toBe('vault:v1:global');
  });

  it('trims a trailing slash off the address rather than posting to a doubled path', async () => {
    const { calls, fetch } = fakeTransit();

    await new OpenBaoKekProvider({
      addr: `${ADDR}/`,
      fetch,
      keyName: KEY_NAME,
      token: TOKEN,
    }).wrap(generateDataEncryptionKey(), { orgId: ORG });

    expect(calls[0]!.url).toBe(`${ADDR}/v1/${TRANSIT_MOUNT}/encrypt/${KEY_NAME}`);
  });
});
