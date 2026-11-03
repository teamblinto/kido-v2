import type { InMemoryMailer } from '../../src/modules/mail/in-memory.mailer';
import type { MailMessage } from '../../src/modules/mail/mailer.port';

/**
 * The most recent delivered message matching `predicate`, waited for rather than read (spec 006
 * research R8) — the newest, as the fake's `lastOf`/`lastTo` answered before.
 *
 * Mail leaves the request path through the outbox now: a suite that read the fake right after the
 * response would read it before the relay's tick. A bounded poll on the observable outcome is the
 * replacement — never a fixed sleep, which passes for timing reasons on one machine and fails for
 * them on another. `OUTBOX_RELAY_TICK_MS=50` under test keeps the wait short. On timeout the
 * rejection carries what the fake did see, so a wrong address or template reads as a wrong
 * address or template and not as "nothing arrived".
 */
export async function awaitMail(
  mailer: InMemoryMailer,
  predicate: (message: MailMessage) => boolean,
  { timeoutMs = 5_000 }: { timeoutMs?: number } = {},
): Promise<MailMessage> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // Reversed rather than `findLast`, which needs the ES2023 lib; the API compiles against ES2022.
    const found = [...mailer.outbox].reverse().find(predicate);

    if (found !== undefined) {
      return found;
    }

    if (Date.now() >= deadline) {
      const seen = mailer.deliveries.map(
        ({ delivery, message }) => `${message.template} → ${message.to} (${delivery.outcome})`,
      );

      throw new Error(
        `no matching mail within ${timeoutMs} ms; the fake saw ${seen.length}: ${seen.join(', ')}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
