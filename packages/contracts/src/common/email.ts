import { z } from 'zod';

/**
 * RFC 5321 §4.5.3.1.3 caps a forward-path at 256 octets including the angle brackets, which leaves
 * 254 for the address itself. Anything longer is undeliverable, so accepting it only moves the
 * failure to a place with less context.
 */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Addresses are normalised *before* they are validated, not after. A pasted `" Ada@Example.COM "`
 * is the same mailbox as `ada@example.com`, and `users.email` is a `citext unique` column
 * (Appendix A), so the boundary is the last place the two spellings can still be told apart —
 * after this, the database treats them as one row and a "duplicate" signup would surface as a
 * constraint violation instead of a conflict we chose to report.
 *
 * The metadata is carried explicitly because the schema is a pipe: its input side is a bare string,
 * so nothing about the mailbox format is derivable from it for the generated OpenAPI document.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(EMAIL_MAX_LENGTH))
  .meta({
    description:
      'An email address. Surrounding whitespace is trimmed and the value is lower-cased.',
    format: 'email',
    maxLength: EMAIL_MAX_LENGTH,
  });

export type Email = z.output<typeof emailSchema>;
