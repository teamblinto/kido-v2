import { describe, expect, it } from 'vitest';

import { escapeHtml, formatDuration, renderHtml, renderText } from './layout';

const BODY = {
  action: { label: 'Confirm', url: 'https://app.forge.dev/auth/verify?token=abc' },
  closing: ['If you did not ask for this, ignore it.'],
  heading: 'Confirm your address',
  paragraphs: ['One paragraph.', 'Another paragraph.'],
} as const;

describe('escapeHtml', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes %s', (raw, escaped) => {
    expect(escapeHtml(raw)).toBe(escaped);
  });

  it('escapes the ampersand first, so an escape is not itself re-escaped', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('Acme Ltd')).toBe('Acme Ltd');
  });
});

describe('renderHtml', () => {
  it('escapes every interpolated value', () => {
    const html = renderHtml({
      ...BODY,
      heading: '<script>alert(1)</script>',
      paragraphs: ['<img src=x onerror=alert(2)>'],
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  /**
   * An organisation name is user-controlled and reaches an invitation mail, so the escape has to
   * survive being placed inside an attribute as well as inside text.
   */
  it('escapes a value that would otherwise break out of the href attribute', () => {
    const html = renderHtml({
      ...BODY,
      action: { label: 'Go', url: 'https://app.forge.dev/x?token=a"><script>alert(1)</script>' },
    });

    expect(html).not.toContain('"><script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('renders the action as an anchor pointing at the url', () => {
    expect(renderHtml(BODY)).toContain(`href="${BODY.action.url}"`);
  });

  it('renders every paragraph', () => {
    const html = renderHtml(BODY);

    for (const paragraph of BODY.paragraphs) {
      expect(html).toContain(paragraph);
    }
  });

  it('renders the closing lines', () => {
    expect(renderHtml(BODY)).toContain(BODY.closing[0]);
  });

  it('omits the action block when there is no action', () => {
    expect(renderHtml({ heading: 'Hello', paragraphs: ['Body.'] })).not.toContain('<a ');
  });

  it('is a complete document, because a mail client renders it standalone', () => {
    expect(renderHtml(BODY)).toMatch(/^<!doctype html>/i);
  });
});

describe('renderText', () => {
  /**
   * The plain-text part is not decoration. A mail sent as HTML only lands in spam far more often,
   * and the console adapter reads its clickable link straight out of this.
   */
  it('contains the action url verbatim, unescaped', () => {
    expect(renderText(BODY)).toContain(BODY.action.url);
  });

  it('contains the heading and every paragraph', () => {
    const text = renderText(BODY);

    expect(text).toContain(BODY.heading);

    for (const paragraph of BODY.paragraphs) {
      expect(text).toContain(paragraph);
    }
  });

  it('carries no html entities, because nothing renders them here', () => {
    expect(renderText({ ...BODY, heading: 'Acme & Co' })).toContain('Acme & Co');
    expect(renderText({ ...BODY, heading: 'Acme & Co' })).not.toContain('&amp;');
  });

  it('carries no tags', () => {
    expect(renderText(BODY)).not.toMatch(/<[a-z]/i);
  });

  it('omits the action line when there is no action', () => {
    expect(renderText({ heading: 'Hello', paragraphs: ['Body.'] })).not.toContain('http');
  });
});

describe('formatDuration', () => {
  it.each([
    [30, '30 minutes'],
    [1, '1 minute'],
    [60, '1 hour'],
    [120, '2 hours'],
    [1_440, '24 hours'],
    [10_080, '7 days'],
    [2_880, '2 days'],
  ])('renders %i minutes as %s', (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });

  /** 90 minutes is not "1 hour"; rounding a stated expiry down is how a support ticket starts. */
  it('falls back to minutes when the value is not a whole number of hours', () => {
    expect(formatDuration(90)).toBe('90 minutes');
  });

  it('falls back to hours when the value is not a whole number of days', () => {
    expect(formatDuration(1_500)).toBe('25 hours');
  });
});
