import { z } from 'zod';

/**
 * A cursor is opaque to the client but not to the network: it travels in a query string and ends up
 * in log lines and cache keys, so the alphabet is base64url and nothing else. That is not a
 * decoding hint — it is what lets the value be interpolated anywhere without escaping.
 */
export const CURSOR_MAX_LENGTH = 512;

/** §03: "100-item page cap, cursor pagination only." The cap is the contract, not a suggestion. */
export const PAGE_SIZE_MAX = 100;

export const PAGE_SIZE_DEFAULT = 25;

export const cursorSchema = z
  .string()
  .min(1)
  .max(CURSOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .meta({
    description:
      'An opaque, base64url-encoded position token. Clients echo it back verbatim and must not ' +
      'construct or interpret one.',
  });

export type Cursor = z.output<typeof cursorSchema>;

/**
 * The query half of every collection endpoint. `limit` is coerced because a query string only ever
 * carries text — `?limit=50` arrives as `'50'`, and the alternative to coercing here is every
 * controller doing it by hand and one of them eventually forgetting.
 *
 * Strict, so `?limt=50` is a 422 rather than a silently ignored typo that returns a page of the
 * wrong size.
 */
export const cursorPageQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

export type CursorPageQuery = z.output<typeof cursorPageQuerySchema>;
