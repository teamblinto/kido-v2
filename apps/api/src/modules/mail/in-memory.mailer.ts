import {
  type MailDelivery,
  type MailMessage,
  type MailTemplateId,
  type MailerPort,
  mailFailed,
  mailSent,
} from './mailer.port';

/** One attempted send and what came of it, delivered or not. */
export interface InMemoryDelivery {
  readonly delivery: MailDelivery;
  readonly message: MailMessage;
}

/**
 * The fake T13, T14, T19 and T29 assert against.
 *
 * The plan's rule for parallel lanes is that a task needing a port another lane owns "writes
 * against the interface and an in-memory fake, never against the adapter". This is that fake, and
 * it ships beside the adapters rather than in a test folder so there is exactly one of it — four
 * sessions each writing their own stub is four subtly different ideas of what a mailer does.
 *
 * It is not registered by `MailModule`. A test that wants it overrides the {@link MAILER} provider:
 *
 * ```ts
 * const mailer = new InMemoryMailer();
 * const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
 *   .overrideProvider(MAILER)
 *   .useValue(mailer)
 *   .compile();
 * ```
 */
export class InMemoryMailer implements MailerPort {
  private readonly attempts: InMemoryDelivery[] = [];
  private readonly scripted: MailDelivery[] = [];

  /** Every attempted send, delivered or not, in order. */
  get deliveries(): readonly InMemoryDelivery[] {
    return [...this.attempts];
  }

  /**
   * The messages that were actually delivered, in order.
   *
   * A copy, so a test cannot edit the record it is asserting on. A failed send is deliberately
   * absent — it did not arrive — and shows up in {@link deliveries} instead, because "it was
   * attempted and it failed" and "it was never attempted" are different bugs.
   */
  get outbox(): readonly MailMessage[] {
    return this.attempts
      .filter(({ delivery }) => delivery.outcome === 'sent')
      .map(({ message }) => message);
  }

  /** Forget everything, including any failure scripted and never used. */
  clear(): void {
    this.attempts.length = 0;
    this.scripted.length = 0;
  }

  /**
   * Make the next send fail.
   *
   * Queued rather than sticky, so scripting two failures in a row is two calls and the common case
   * — one failure, then normal service — needs no cleanup. The default is retryable, because that
   * is the interesting case: an outage that must not cost the caller its transaction.
   */
  failNext(delivery: MailDelivery = mailFailed('unavailable', 'scripted by InMemoryMailer')): void {
    this.scripted.push(delivery);
  }

  /**
   * The most recent message of a given template, whoever it went to.
   *
   * Filtered and taken from the end rather than `findLast`, which needs the ES2023 lib; the API
   * compiles against ES2022.
   */
  lastOf(template: MailTemplateId): MailMessage | undefined {
    return this.outbox.filter((message) => message.template === template).at(-1);
  }

  /** The most recent message delivered to an address. */
  lastTo(address: string): MailMessage | undefined {
    return this.to(address).at(-1);
  }

  send(message: MailMessage): Promise<MailDelivery> {
    const delivery = this.scripted.shift() ?? mailSent();

    this.attempts.push({ delivery, message });

    return Promise.resolve(delivery);
  }

  /**
   * Everything delivered to an address, in order.
   *
   * Case-insensitive, because `users.email` is `citext` (T04): `Someone@Example.com` and
   * `someone@example.com` are one account, and a fake that disagreed would let a test pass that the
   * database would fail.
   */
  to(address: string): readonly MailMessage[] {
    const wanted = address.toLowerCase();

    return this.outbox.filter((message) => message.to.toLowerCase() === wanted);
  }
}
