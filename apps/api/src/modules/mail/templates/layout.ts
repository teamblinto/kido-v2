/**
 * The one place a mail turns into bytes, in both parts, from one description.
 *
 * The HTML and the text are rendered from the same {@link MailBody} rather than written twice,
 * because two hand-written parts drift: the day the link changes in one of them, half the
 * recipients get a dead mail and nothing fails.
 *
 * There is no template engine here and no dependency added for one. These are three transactional
 * mails with a heading, a few sentences and one button.
 */

/**
 * A mail as content, before it is either escaped into HTML or flattened into text.
 *
 * Every string in here is treated as **plain text** — never as markup. `renderHtml` escapes all of
 * it, which is what makes an organisation name chosen by a stranger safe to interpolate.
 */
export interface MailBody {
  /** The single call to action. Omitted for a mail that only informs. */
  readonly action?: { readonly label: string; readonly url: string };
  /** Trailing lines, set smaller: "if you did not ask for this…". */
  readonly closing?: readonly string[];
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

/**
 * HTML entity escaping for text destined for either an element body or a quoted attribute.
 *
 * The ampersand is replaced first, or every subsequent escape would have its own `&` re-escaped.
 * Both quote characters are covered because `url` is interpolated into an `href="…"`, where a bare
 * `"` ends the attribute and starts an injection.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Inline styles and a table-free single column, deliberately.
 *
 * Mail clients strip `<style>` blocks, ignore most of a stylesheet and disagree about the rest, so
 * anything that must survive is set on the element. The layout degrades to a readable stack in a
 * client that supports none of it, which is the only presentation guarantee worth making.
 */
export function renderHtml(body: MailBody): string {
  const paragraphs = body.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(paragraph)}</p>`,
    )
    .join('');

  const action =
    body.action === undefined
      ? ''
      : `<p style="margin:24px 0;"><a href="${escapeHtml(body.action.url)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#111827;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(body.action.label)}</a></p>` +
        // Repeated as text because a client that blocks the button still has to be usable, and
        // because a reader who wants to check where a link goes before following it should be able
        // to read it rather than hover it.
        `<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#6b7280;">Or paste this into your browser:<br><span style="word-break:break-all;">${escapeHtml(body.action.url)}</span></p>`;

  const closing = (body.closing ?? [])
    .map(
      (line) =>
        `<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">${escapeHtml(line)}</p>`,
    )
    .join('');

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(body.heading)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;color:#111827;">',
    '<div style="max-width:560px;margin:0 auto;padding:32px;background:#ffffff;border-radius:12px;">',
    `<h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;">${escapeHtml(body.heading)}</h1>`,
    paragraphs,
    action,
    closing,
    '</div></body></html>',
  ].join('');
}

/** The same content as a plain-text mail. No entities: nothing renders them here. */
export function renderText(body: MailBody): string {
  const blocks = [body.heading, ...body.paragraphs];

  if (body.action !== undefined) {
    blocks.push(`${body.action.label}: ${body.action.url}`);
  }

  blocks.push(...(body.closing ?? []));

  return `${blocks.join('\n\n')}\n`;
}

const MINUTES_PER_DAY = 1_440;
const MINUTES_PER_HOUR = 60;

/**
 * A duration in the units a reader thinks in — "24 hours", not "1440 minutes".
 *
 * It only promotes to a larger unit when the value divides exactly. 90 minutes is not "1 hour", and
 * rounding a stated expiry down is how somebody follows a link they were told had already expired,
 * or lets one lapse they were told they still had.
 *
 * Days start at two. A verification token lives for exactly one day and spec 001 calls that window
 * "24 h" throughout, which is also the clearer sentence: "1 day" reads as a calendar boundary — is
 * that midnight? — where "24 hours" is unambiguously a stopwatch from when the mail arrived.
 */
export function formatDuration(minutes: number): string {
  if (minutes % MINUTES_PER_DAY === 0 && minutes >= 2 * MINUTES_PER_DAY) {
    return plural(minutes / MINUTES_PER_DAY, 'day');
  }

  if (minutes % MINUTES_PER_HOUR === 0) {
    return plural(minutes / MINUTES_PER_HOUR, 'hour');
  }

  return plural(minutes, 'minute');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
