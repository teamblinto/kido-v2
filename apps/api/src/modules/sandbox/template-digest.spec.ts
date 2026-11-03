import { describe, expect, it } from 'vitest';

import { snapshotName, templateDigest } from './template-digest';

const manifest = { base: 'node:22-bookworm', description: 'd', install: 'pnpm i', name: 'n' };
const file = (path: string, content: string) => ({ content: Buffer.from(content), path });

describe('templateDigest', () => {
  it('is 64 hex and does not depend on file order', () => {
    const a = templateDigest(manifest, [file('src/b.ts', 'b'), file('a.ts', 'a')]);
    const b = templateDigest(manifest, [file('a.ts', 'a'), file('src/b.ts', 'b')]);

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('hashes CRLF and LF content the same', () => {
    expect(templateDigest(manifest, [file('a.ts', 'one\r\ntwo\r\n')])).toBe(
      templateDigest(manifest, [file('a.ts', 'one\ntwo\n')]),
    );
  });

  it('changes when one byte changes', () => {
    expect(templateDigest(manifest, [file('a.ts', 'abc')])).not.toBe(
      templateDigest(manifest, [file('a.ts', 'abd')]),
    );
  });

  it('changes when a file is renamed', () => {
    expect(templateDigest(manifest, [file('a.ts', 'abc')])).not.toBe(
      templateDigest(manifest, [file('b.ts', 'abc')]),
    );
  });

  it('changes when the manifest changes, but not when its key order does', () => {
    const files = [file('a.ts', 'abc')];

    expect(templateDigest({ ...manifest, install: 'npm i' }, files)).not.toBe(
      templateDigest(manifest, files),
    );
    expect(
      templateDigest(
        { name: 'n', install: 'pnpm i', description: 'd', base: manifest.base },
        files,
      ),
    ).toBe(templateDigest(manifest, files));
  });

  it('does not special-case devPort — a caller must exclude it before hashing (research R9)', () => {
    const files = [file('a.ts', 'abc')];

    // templateDigest hashes whatever record it is given; devPort rotates nothing only because
    // TemplateCatalogue strips it before calling in here (template-catalogue.ts `loadOne`).
    expect(templateDigest({ ...manifest, devPort: '3000' }, files)).not.toBe(
      templateDigest(manifest, files),
    );
    expect(templateDigest({ ...manifest, devPort: '65535' }, files)).not.toBe(
      templateDigest({ ...manifest, devPort: '1024' }, files),
    );
  });

  it('does not special-case devCommand either — the caller excludes it too (research R3)', () => {
    const files = [file('a.ts', 'abc')];

    // Same bargain as devPort: a start command changes no byte of a built image, so `loadOne`
    // leaves it out of the record it hands in here. Nothing in this function knows the name.
    expect(templateDigest({ ...manifest, devCommand: 'npm run dev' }, files)).not.toBe(
      templateDigest(manifest, files),
    );
    expect(templateDigest({ ...manifest, devCommand: 'npm start' }, files)).not.toBe(
      templateDigest({ ...manifest, devCommand: 'npm run dev' }, files),
    );
  });
});

describe('snapshotName', () => {
  it('is forge-tpl-<id>-<12 hex> and only [a-z0-9._-]', () => {
    const digest = templateDigest(manifest, [file('a.ts', 'abc')]);
    const name = snapshotName('vite-react', digest);

    expect(name).toBe(`forge-tpl-vite-react-${digest.slice(0, 12)}`);
    expect(name).toMatch(/^[a-z0-9._-]+$/);
  });
});
