import { describe, expect, it } from 'vitest';

import { highlight } from './highlight';

describe('highlight', () => {
  it('colours a file whose extension has a registered grammar', () => {
    const html = highlight('src/a.ts', 'const x = 1;');

    expect(html).toContain('hljs-keyword');
  });

  it.each(['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'md', 'py', 'sh', 'yaml', 'sql'])(
    'has a grammar for .%s',
    (extension) => {
      expect(highlight(`a.${extension}`, 'x')).not.toBeNull();
    },
  );

  it('is null for an extension with no grammar, so the caller falls back to monospace', () => {
    expect(highlight('notes.rs', 'fn main() {}')).toBeNull();
    expect(highlight('Makefile', 'all:')).toBeNull();
    expect(highlight('.gitignore', 'node_modules')).toBeNull();
  });

  it('ignores the case of the extension', () => {
    expect(highlight('README.MD', '# hi')).not.toBeNull();
  });

  it('escapes the markup a file contains rather than emitting it', () => {
    // The result is injected with dangerouslySetInnerHTML, so this is the property that keeps
    // a file's own text from becoming markup.
    const html = highlight('a.md', '<img src=x onerror=alert(1)>');

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;');
  });
});
