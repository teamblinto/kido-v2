import type { Environment } from '../../config/environment';
import { type MailDelivery, type MailMessage, type MailerPort, mailSent } from './mailer.port';

/**
 * The console adapter was selected on a deployment where mail actually has to arrive.
 *
 * Deliberately a boot failure rather than a warning, for the reason `EnvKekProvider` refuses to
 * construct off `local`: a deployment that writes its verification links into a log file reports
 * every send as successful, so the first sign of trouble is a user saying the mail never came.
 */
export class ConsoleMailerRefusedError extends Error {
  constructor(deployEnv: string) {
    super(
      `MAIL_PROVIDER is "console", which prints mail to stdout instead of delivering it, and DEPLOY_ENV is ${JSON.stringify(deployEnv)}. Set MAIL_PROVIDER=resend on anything but a local deployment.`,
    );
    this.name = new.target.name;
  }
}

export interface ConsoleMailerOptions {
  /** Local only. See {@link ConsoleMailerRefusedError}. */
  readonly deployEnv: Environment['DEPLOY_ENV'];
  readonly from: string;
  /** Where the rendered mail lands. Defaults to stdout; a test passes a collector. */
  readonly write?: (line: string) => void;
}

/**
 * Everything a browser will open from a terminal. `otpauth://` and `mailto:` deliberately do not
 * match: a TOTP seed is not something to make one keystroke away from a QR generator.
 */
const CLICKABLE_URL = /https?:\/\/[^\s<>"']+/;

/**
 * A URL at the end of an English sentence keeps its full stop under a greedy match, and a link with
 * a trailing `.` is a link that 404s. Trailing punctuation that is never significant at the end of
 * a real URL is trimmed; `/`, `=` and `-` are left alone because they are.
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/** The first link in a body of text, as something a terminal can be trusted to linkify. */
export function firstUrlIn(text: string): string | undefined {
  const match = CLICKABLE_URL.exec(text);

  if (match === null) {
    return undefined;
  }

  const trimmed = match[0].replace(TRAILING_PUNCTUATION, '');

  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The development transport: the mail, printed.
 *
 * A developer signing up locally has to be able to click through to verification without opening a
 * database, so the link is printed alone on its own line — terminals linkify a bare URL, and one
 * with anything trailing it is one that does not open.
 *
 * ## Why this writes to stdout rather than through the logger
 *
 * That output carries a live verification or reset token, and T09's transport scrubber censors
 * exactly that shape — `?token=…` — on its way through the logger. Routing this adapter's output
 * through the logger would therefore print `[Redacted:query-credential]` where the link should be,
 * which is the one thing this adapter exists to avoid.
 *
 * The resolution is not to weaken the scrubber. It is that this output *is the mail*, not a log
 * line about the mail: the console adapter is the delivery channel in development, the same way
 * Resend is in production, and a delivery channel is allowed to carry the token it is delivering.
 * What keeps that honest is the refusal above — the adapter cannot be constructed off `local`, so
 * the only terminal it can ever reach is the developer's own. Every *log* line this module emits,
 * including every one in `ResendMailer`, still goes through the scrubber and still carries no
 * token. ADR 004 records the trade.
 */
export class ConsoleMailer implements MailerPort {
  private readonly from: string;
  private readonly write: (line: string) => void;

  constructor(options: ConsoleMailerOptions) {
    if (options.deployEnv !== 'local') {
      throw new ConsoleMailerRefusedError(options.deployEnv);
    }

    this.from = options.from;
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  }

  /**
   * Always succeeds. There is nothing between this and the terminal that can fail, and inventing a
   * failure mode here would mean the development path exercised code no deployment ever runs.
   */
  send(message: MailMessage): Promise<MailDelivery> {
    const link = firstUrlIn(message.text);

    this.write(
      [
        '',
        '──────────── mail (console adapter, not delivered) ────────────',
        `template  ${message.template}`,
        `from      ${this.from}`,
        `to        ${message.to}`,
        `subject   ${message.subject}`,
        '',
        // The text part only. The HTML is noise in a terminal and would bury the link.
        message.text.trimEnd(),
        ...(link === undefined ? [] : ['', 'link:', link]),
        '───────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );

    return Promise.resolve(mailSent());
  }
}
