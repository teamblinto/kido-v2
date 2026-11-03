import type {
  WebhookResolution,
  WebhookResolverPort,
} from '../../src/modules/webhooks/outbound/resolver.port';

/**
 * An in-memory `WebhookResolverPort` for spec 029 (research R8, R14): what `NodeResolverAdapter`
 * answers, without a resolver.
 *
 * - `set(host, answers)` scripts successive calls: the first `resolve(host)` gets `answers[0]`, the
 *   next `answers[1]`, and the last one repeats. An empty address list answers `empty`. Scripting a
 *   public address then `127.0.0.1` is how a test plays DNS rebinding.
 * - `unavailable(host)` makes every call for `host` answer `unavailable` until `set` or `reset`.
 * - A host with nothing set answers `empty` (NXDOMAIN).
 * - `asked` lists every host resolved, in order.
 *
 * Hosts are compared lowercase with any trailing dot dropped.
 */
export class FakeResolver implements WebhookResolverPort {
  readonly asked: string[] = [];
  private readonly scripts = new Map<
    string,
    { answers: readonly (readonly string[])[]; next: number }
  >();
  private readonly down = new Set<string>();

  set(host: string, answers: readonly (readonly string[])[]): this {
    if (answers.length === 0) throw new Error('FakeResolver.set needs at least one answer');
    const key = canonical(host);
    this.down.delete(key);
    this.scripts.set(key, { answers, next: 0 });
    return this;
  }

  unavailable(host: string): this {
    this.down.add(canonical(host));
    return this;
  }

  reset(): void {
    this.asked.length = 0;
    this.scripts.clear();
    this.down.clear();
  }

  resolve(host: string): Promise<WebhookResolution> {
    const key = canonical(host);
    this.asked.push(key);
    if (this.down.has(key)) return Promise.resolve({ kind: 'unavailable' });

    const script = this.scripts.get(key);
    if (script === undefined) return Promise.resolve({ kind: 'empty' });
    const addresses = script.answers[Math.min(script.next, script.answers.length - 1)]!;
    script.next += 1;
    return Promise.resolve(
      addresses.length === 0 ? { kind: 'empty' } : { addresses: [...addresses], kind: 'answer' },
    );
  }
}

function canonical(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}
