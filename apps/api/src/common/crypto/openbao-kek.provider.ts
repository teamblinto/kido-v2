import { type DataEncryptionKey, dataEncryptionKey, revealDataEncryptionKey } from './branded';
import {
  type KekBinding,
  type KekProvider,
  KekUnwrapError,
  UnknownKekError,
  type WrappedDek,
} from './kek-provider.port';

/** Where the transit secrets engine is mounted. OpenBao's default, and the one the runbook assumes. */
export const TRANSIT_MOUNT = 'transit';

/** The status transit answers a genuine decrypt refusal with. Everything else is our problem, not the row's. */
const DECRYPT_REFUSED = 400;

/** Just enough of a `fetch` response for this adapter, so no DOM lib is pulled into the API's types. */
export interface OpenBaoResponse {
  json(): Promise<unknown>;
  readonly ok: boolean;
  readonly status: number;
}

export type OpenBaoFetch = (
  url: string,
  init: { body: string; headers: Record<string, string>; method: string },
) => Promise<OpenBaoResponse>;

export interface OpenBaoKekProviderOptions {
  readonly addr: string;
  /** Injected in tests; production would use the platform `fetch`. See {@link OpenBaoKekProvider}. */
  readonly fetch?: OpenBaoFetch;
  readonly keyName: string;
  readonly token: string;
}

/**
 * The vault could not answer: unreachable, unauthorised, out of quota, or answering nonsense.
 *
 * Deliberately *not* a {@link KekUnwrapError}. The two failures call for opposite responses — page
 * an operator versus treat the row as unreadable — and collapsing them would turn a five-minute
 * OpenBao outage into a report that every tenant's data key is corrupt.
 */
export class OpenBaoTransportError extends Error {
  readonly status: number | undefined;

  constructor(operation: string, status?: number, cause?: unknown) {
    // The operation and the status: enough to tell a 403 from a 503 without naming the key, the
    // token, the ciphertext or the organisation.
    super(
      status === undefined
        ? `OpenBao ${operation} failed before a response was received.`
        : `OpenBao ${operation} failed with status ${status}.`,
    );
    this.cause = cause;
    this.name = 'OpenBaoTransportError';
    this.status = status;
  }
}

/**
 * The production key-encryption key: OpenBao's transit engine, which wraps and unwraps without the
 * master key ever entering this process.
 *
 * **This adapter ships unwired.** §05 names OpenBao as where the KEK lives, spec 001 puts deploying
 * it out of scope, and ADR 003 records the consequence: the envelope primitive is built now behind
 * a port, this adapter is written and tested against the transit contract now, and the deployment
 * that turns `KEK_PROVIDER=openbao` on is a later, separate change. Writing it later, against a
 * running vault, would mean discovering then that the port's shape was wrong.
 *
 * ## The transit key this expects
 *
 * Created with `derived=true`. That is what makes `context` — the organisation id — select a
 * distinct data key per tenant inside the vault, so tenant separation is enforced by the engine
 * rather than by our own AAD handling. `convergent_encryption` stays off: two organisations that
 * happen to hold the same DEK must not produce the same ciphertext.
 */
export class OpenBaoKekProvider implements KekProvider {
  readonly kekId: string;

  private readonly addr: string;
  private readonly fetch: OpenBaoFetch | undefined;
  private readonly keyName: string;
  private readonly token: string;

  constructor(options: OpenBaoKekProviderOptions) {
    // A trailing slash in `OPENBAO_ADDR` is the single most common way to configure this, and
    // `https://host:8200//v1/transit/...` is a 404 that reads like a missing mount.
    this.addr = options.addr.replace(/\/+$/, '');
    this.fetch = options.fetch;
    this.keyName = options.keyName;
    this.kekId = `openbao:${options.keyName}`;
    this.token = options.token;
  }

  async unwrap(wrapped: WrappedDek, binding: KekBinding): Promise<DataEncryptionKey> {
    if (wrapped.kekId !== this.kekId) {
      throw new UnknownKekError(wrapped.kekId);
    }

    const data = await this.post('decrypt', {
      ciphertext: wrapped.ciphertext.toString('utf8'),
      context: contextFor(binding),
    });

    if (typeof data.plaintext !== 'string') {
      throw new OpenBaoTransportError('decrypt', undefined);
    }

    try {
      return dataEncryptionKey(Buffer.from(data.plaintext, 'base64'));
    } catch {
      // The vault decrypted something, but it is not a data key — a wrong transit key, or a row
      // written by something other than this adapter. Re-stated without the bytes.
      throw new KekUnwrapError(
        'Refusing to unwrap: OpenBao returned a value that is not a data-encryption key.',
      );
    }
  }

  async wrap(dek: DataEncryptionKey, binding: KekBinding): Promise<WrappedDek> {
    const data = await this.post('encrypt', {
      context: contextFor(binding),
      // The only encoding transit accepts. This is the one moment the DEK leaves the process, and
      // it leaves over TLS to the service whose whole job is to hold it.
      plaintext: revealDataEncryptionKey(dek).toString('base64'),
    });

    if (typeof data.ciphertext !== 'string') {
      throw new OpenBaoTransportError('encrypt', undefined);
    }

    // Stored verbatim: the `vault:v2:` prefix is how the engine knows which version of its own key
    // produced the wrap, which is what lets transit rotate underneath us.
    return { ciphertext: Buffer.from(data.ciphertext, 'utf8'), kekId: this.kekId };
  }

  private async post(
    operation: 'decrypt' | 'encrypt',
    body: Record<string, string>,
  ): Promise<{ ciphertext?: unknown; plaintext?: unknown }> {
    const url = `${this.addr}/v1/${TRANSIT_MOUNT}/${operation}/${this.keyName}`;
    // Resolved per call rather than in the constructor: the adapter is unwired, so the global may
    // legitimately not exist yet — or be replaced — when one of these is built.
    const send = this.fetch ?? ((target, init) => globalThis.fetch(target, init));
    let response: OpenBaoResponse;

    try {
      response = await send(url, {
        body: JSON.stringify(body),
        // The token is a bearer credential and goes in a header: a query parameter would be written
        // to every proxy access log between here and the vault.
        headers: { 'Content-Type': 'application/json', 'X-Vault-Token': this.token },
        method: 'POST',
      });
    } catch (cause) {
      throw new OpenBaoTransportError(operation, undefined, cause);
    }

    if (!response.ok) {
      if (operation === 'decrypt' && response.status === DECRYPT_REFUSED) {
        throw new KekUnwrapError();
      }

      throw new OpenBaoTransportError(operation, response.status);
    }

    const payload = (await response.json()) as { data?: Record<string, unknown> } | null;

    return payload?.data ?? {};
  }
}

/** Transit takes the derivation context base64-encoded, like everything else in its API. */
function contextFor({ orgId }: KekBinding): string {
  return Buffer.from(orgId, 'utf8').toString('base64');
}
