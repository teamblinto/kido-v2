import { verificationTokenSchema } from '@repo/contracts';
import { useSearchParams } from 'react-router-dom';

/**
 * The query parameter every mailed link carries its token in.
 *
 * Mirrors `MAIL_LINK_TOKEN_PARAM` in `apps/api/src/modules/mail/links.ts`, which explains at length
 * why it is a query parameter and why it is spelled this: T09's transport scrubber censors URL
 * credentials *by parameter name*, so a token in a path segment would sail through every access log
 * uncensored. Renaming either side silently breaks the link, which is why both are constants with
 * the reason attached rather than inline strings.
 */
export const LINK_TOKEN_PARAM = 'token';

/**
 * The token from the current URL, validated against the contract before anything is sent.
 *
 * `null` distinguishes "this link has no token" — somebody reached the page directly, or a mail
 * client truncated the URL — from a token that is present and simply wrong, which only the server
 * can rule on. The two need different copy: one says check the link you copied, the other says ask
 * for a new one.
 */
export function useLinkToken(): string | null {
  const [params] = useSearchParams();
  const parsed = verificationTokenSchema.safeParse(params.get(LINK_TOKEN_PARAM) ?? '');

  return parsed.success ? parsed.data : null;
}
