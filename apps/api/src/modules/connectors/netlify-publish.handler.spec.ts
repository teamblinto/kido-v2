import { describe, expect, it } from 'vitest';

import { spaRedirects } from './netlify-publish.handler';

const entry = { sha: 'a'.repeat(64), size: 1, type: 'text/html' };

/** Netlify serves only what it is given: a published SPA gets the fallback Kido's host gives it. */
describe('spaRedirects', () => {
  it('rewrites unknown paths to index.html for a release with one', () => {
    expect(spaRedirects({ 'assets/app.js': entry, 'index.html': entry })?.toString()).toBe(
      '/*    /index.html    200\n',
    );
  });

  it('leaves a release with its own redirect config, or no index.html, as it is', () => {
    expect(spaRedirects({ _redirects: entry, 'index.html': entry })).toBeUndefined();
    expect(spaRedirects({ 'index.html': entry, 'netlify.toml': entry })).toBeUndefined();
    expect(spaRedirects({ 'about.html': entry })).toBeUndefined();
  });
});
