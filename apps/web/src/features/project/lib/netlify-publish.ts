/** What a failed or refused Netlify publish means, by its `reason` (contracts § 5). */
export const PUBLISH_REASON: Readonly<Record<string, string>> = {
  'build-failed': 'The build failed, so nothing was sent to Netlify. Open its log in the history.',
  'in-flight': 'A publish is already running; try again when it finishes.',
  'missing-scope': 'The Netlify token is missing a permission; reconnect it in settings.',
  'needs-reauth': 'The Netlify connection needs to be reconnected in organisation settings.',
  'not-found': 'The release to publish no longer exists; deploy again.',
  'provider-refused': 'Netlify rejected the deploy. Its deploy log on Netlify says why.',
  'provider-unavailable': 'Netlify is not answering right now; try again shortly.',
  'quota-exceeded': 'The Netlify account has reached a plan limit.',
  'rate-limited': 'Netlify is rate limiting this account; try again in a few minutes.',
  'site-gone': 'The Netlify site no longer exists; choose another site.',
  'timed-out': 'The build or publish took too long; try again.',
};
