import { describe, expect, it } from 'vitest';

import { cleanGeneratedName, humanizeName, namingPrompt, readmeExcerpt } from './project-naming';

describe('humanizeName', () => {
  it.each([
    ['acme-dashboard', 'Acme Dashboard'],
    ['acme_dashboard_v2', 'Acme Dashboard'],
    ['@acme/web-app', 'Acme Web'],
    ['myAPIServer', 'My API Server'],
    ['todo.app', 'Todo'],
    ['app', 'App'],
    ['ai-chat-ui', 'AI Chat UI'],
    ['---', 'Untitled project'],
  ])('%s → %s', (raw, name) => {
    expect(humanizeName(raw)).toBe(name);
  });
});

describe('cleanGeneratedName', () => {
  it('takes the first line and strips quotes, labels and a trailing full stop', () => {
    expect(cleanGeneratedName('"Pixel Garden".\nBecause it grows')).toBe('Pixel Garden');
    expect(cleanGeneratedName('Name: Rota Board')).toBe('Rota Board');
  });

  it('refuses an answer that is not a name', () => {
    expect(cleanGeneratedName('')).toBeNull();
    expect(
      cleanGeneratedName('This is a long sentence about the project and what it does'),
    ).toBeNull();
  });
});

describe('readmeExcerpt', () => {
  it('is the title and the first real paragraph, badges and HTML dropped', () => {
    const readme =
      '# Acme Rota\n\n[![build](x.svg)](y)\n<p align="center">logo</p>\n\nA weekly on-call rota board for small engineering teams.\n\n## Install';

    expect(readmeExcerpt(readme)).toBe(
      'Acme Rota\nA weekly on-call rota board for small engineering teams.',
    );
    expect(readmeExcerpt(undefined)).toBeNull();
  });
});

describe('namingPrompt', () => {
  it('bounds every part, so a huge prompt or README cannot blow up a naming call', () => {
    const prompt = namingPrompt({ prompt: 'x'.repeat(10_000), readme: 'y'.repeat(10_000) });

    expect(prompt.length).toBeLessThan(4_500);
    expect(prompt.endsWith('Name this project.')).toBe(true);
  });
});
