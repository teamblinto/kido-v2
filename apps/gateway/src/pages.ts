import type { ServerResponse } from 'node:http';

/**
 * The gateway's opaque HTML answers (contracts/preview.md § 2/§ 8, research R12). Every refusal
 * renders the identical `404` body regardless of *why* (unknown label, no sandbox, not entitled,
 * undeclared port, unverifiable route) — a body would be a probe oracle, same reasoning as the
 * broker's `404 {}` (§ 3). None of these templates carries a project, org, sandbox or label
 * identifier: that is the one invariant `pages.spec.ts` checks for all four.
 */
export interface Page {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

function htmlPage(
  status: number,
  title: string,
  message: string,
  headers?: Record<string, string>,
  head = '',
): Page {
  return {
    status,
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}<title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`,
    headers,
  };
}

/** Unknown label, no sandbox, not entitled, undeclared port, or an unverifiable route: one body. */
export const REFUSED_PAGE: Page = htmlPage(404, 'Not found', 'Nothing is here.');

/** Route valid, sandbox ready, but the upstream refused the connection (research R12). */
export const NOT_SERVING_PAGE: Page = htmlPage(503, 'Not serving', 'Nothing is serving yet.');

/**
 * `because: 'resuming'` (T041/T042): rendered immediately, before any retry. A browser ignores
 * `Retry-After` on a document, so the meta refresh is what makes "will retry" true — in the
 * project's frame too; the waking budget ends it with COULD_NOT_WAKE_PAGE, which has none.
 */
export const WAKING_PAGE: Page = htmlPage(
  202,
  'Waking up',
  'Starting up. This page will retry shortly.',
  {
    'Retry-After': '2',
  },
  '<meta http-equiv="refresh" content="2">',
);

/** T042: the resume failed, or the sandbox never became routable within the stated budget. */
export const COULD_NOT_WAKE_PAGE: Page = htmlPage(
  503,
  'Could not wake',
  'This could not be started. Try again shortly.',
);

/** A site whose manifest is invalid or whose store is unreachable (contracts/site-serving.md § 5). */
export const SITE_UNAVAILABLE_PAGE: Page = htmlPage(
  503,
  'Unavailable',
  'This site is temporarily unavailable. Try again shortly.',
  { 'Retry-After': '5' },
);

/** The manifest names a file the store does not hold (contracts/site-serving.md § 5). */
export const SITE_BROKEN_PAGE: Page = htmlPage(502, 'Bad gateway', 'This file could not be read.');

/** A site answers `GET` and `HEAD` only. */
export const METHOD_NOT_ALLOWED_PAGE: Page = htmlPage(
  405,
  'Method not allowed',
  'Only GET and HEAD are served here.',
  { Allow: 'GET, HEAD' },
);

/** Writes `page` to `res`: status, `Content-Type`, `Cache-Control: no-store`, any page headers. */
export function send(res: ServerResponse, page: Page): void {
  res.writeHead(page.status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...page.headers,
  });
  res.end(page.body);
}
