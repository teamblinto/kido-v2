import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MemoryObjectStore } from '../../common/object-store/memory-object-store';
import type { ObjectStorePort } from '../../common/object-store/object-store.port';
import {
  assetIndexKey,
  blobKey,
  buildManifest,
  canonicalJson,
  contentTypeFor,
  manifestKey,
  upload,
  type ArtifactFile,
} from './artifact';

const ORG = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';

function sha(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function file(path: string, body: string): ArtifactFile {
  return { path, body: Buffer.from(body) };
}

const FILES: ArtifactFile[] = [
  file('index.html', '<script src="/assets/app.js"></script>'),
  file('assets/app.js', 'console.log(1)'),
  file('assets/style.css', 'body{}'),
];

/** Records every call, in order, around a `MemoryObjectStore`. */
class RecordingStore implements ObjectStorePort {
  readonly inner = new MemoryObjectStore();
  readonly calls: string[] = [];

  async put(key: string, body: Buffer, meta: Readonly<Record<string, string>>): Promise<void> {
    this.calls.push(`put ${key}`);
    await this.inner.put(key, body, meta);
  }

  get(key: string): Promise<{ body: Buffer; meta: Record<string, string> } | null> {
    this.calls.push(`get ${key}`);
    return this.inner.get(key);
  }

  head(key: string): Promise<{ meta: Record<string, string> } | null> {
    this.calls.push(`head ${key}`);
    return this.inner.head(key);
  }

  delete(key: string): Promise<void> {
    this.calls.push(`delete ${key}`);
    return this.inner.delete(key);
  }
}

describe('canonicalJson', () => {
  it('sorts keys at every level and writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('buildManifest', () => {
  it('is canonical: the same files in any order give the same bytes and the same sha', () => {
    const one = buildManifest(FILES);
    const two = buildManifest([...FILES].reverse());
    expect(two.bytes.equals(one.bytes)).toBe(true);
    expect(two.artifactSha).toBe(one.artifactSha);
    expect(one.bytes.toString()).toBe(
      canonicalJson({
        files: {
          'assets/app.js': { sha: sha('console.log(1)'), size: 14, type: 'text/javascript' },
          'assets/style.css': { sha: sha('body{}'), size: 6, type: 'text/css' },
          'index.html': {
            sha: sha(FILES[0]!.body),
            size: FILES[0]!.body.length,
            type: 'text/html; charset=utf-8',
          },
        },
        version: 1,
      }),
    );
  });

  it('artifactSha is the sha-256 of exactly those bytes', () => {
    const { artifactSha, bytes } = buildManifest(FILES);
    expect(artifactSha).toBe(sha(bytes));
    expect(artifactSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a different body gives a different artifact', () => {
    expect(buildManifest([file('index.html', 'a')]).artifactSha).not.toBe(
      buildManifest([file('index.html', 'b')]).artifactSha,
    );
  });

  it('refuses a duplicate path rather than letting one entry shadow the other', () => {
    expect(() => buildManifest([file('a.txt', '1'), file('a.txt', '2')])).toThrow(/duplicate/);
  });

  /**
   * The tar reader lets any segment through that is not empty, `.` or `..`, so a build can emit a
   * top-level `__proto__`. On a plain object that assignment would set the prototype: the file
   * would be uploaded but missing from the manifest, and never served.
   */
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'keeps a file named %s as an ordinary entry',
    (name) => {
      const body = Buffer.from(`body of ${name}`);
      const { bytes, manifest } = buildManifest([
        file(name, `body of ${name}`),
        file('index.html', 'i'),
      ]);

      expect(Object.hasOwn(manifest.files, name)).toBe(true);
      expect(manifest.files[name]).toEqual({
        sha: createHash('sha256').update(body).digest('hex'),
        size: body.length,
        type: 'application/octet-stream',
      });
      const parsed = JSON.parse(bytes.toString('utf8')) as { files: Record<string, unknown> };
      expect(Object.keys(parsed.files).sort()).toEqual([name, 'index.html'].sort());
    },
  );

  it('refuses a duplicate __proto__ like any other duplicate', () => {
    expect(() => buildManifest([file('__proto__', '1'), file('__proto__', '2')])).toThrow(
      /duplicate/,
    );
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['page.HTM', 'text/html; charset=utf-8'],
    ['assets/app.js', 'text/javascript'],
    ['assets/app.mjs', 'text/javascript'],
    ['assets/style.css', 'text/css'],
    ['data.json', 'application/json'],
    ['assets/app.js.map', 'application/json'],
    ['site.webmanifest', 'application/manifest+json'],
    ['robots.txt', 'text/plain; charset=utf-8'],
    ['sitemap.xml', 'application/xml'],
    ['logo.svg', 'image/svg+xml'],
    ['a.png', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.gif', 'image/gif'],
    ['a.webp', 'image/webp'],
    ['a.avif', 'image/avif'],
    ['favicon.ico', 'image/x-icon'],
    ['f.woff', 'font/woff'],
    ['f.woff2', 'font/woff2'],
    ['f.ttf', 'font/ttf'],
    ['f.otf', 'font/otf'],
    ['m.wasm', 'application/wasm'],
    ['d.pdf', 'application/pdf'],
    ['v.mp4', 'video/mp4'],
    ['v.webm', 'video/webm'],
    ['a.mp3', 'audio/mpeg'],
    ['a.wav', 'audio/wav'],
  ])('%s is %s, from the fixed table', (path, type) => {
    expect(contentTypeFor(path)).toBe(type);
  });

  it.each([
    'README',
    'archive.tar.gz',
    'script.php',
    '.htaccess',
    'dir.js/file',
    'x.',
    'x.toString',
  ])('unknown %s is application/octet-stream', (path) => {
    expect(contentTypeFor(path)).toBe('application/octet-stream');
  });
});

describe('upload', () => {
  it('writes each distinct blob once, then the manifest, then confirms the manifest with head last', async () => {
    const store = new RecordingStore();
    const twin = [...FILES, file('copy.js', 'console.log(1)')];
    const result = await upload(store, ORG, PROJECT, twin);

    const { artifactSha, bytes } = buildManifest(twin);
    const totalBytes = twin.reduce((sum, each) => sum + each.body.length, 0);
    expect(result).toEqual({ artifactSha, fileCount: 4, totalBytes });

    const manifestAt = manifestKey(ORG, PROJECT, artifactSha);
    expect(manifestAt).toBe(`${ORG}/${PROJECT}/${artifactSha}/manifest.json`);
    const puts = store.calls.filter((call) => call.startsWith('put '));
    expect(puts).toHaveLength(6); // three distinct bodies + two asset-index entries + the manifest
    expect(puts.at(-1)).toBe(`put ${manifestAt}`);
    expect(store.calls.at(-1)).toBe(`head ${manifestAt}`);
    // First a probe for a byte-identical artifact, then the blobs, then the asset index, then
    // the manifest.
    expect(store.calls[0]).toBe(`head ${manifestAt}`);
    const manifestPut = store.calls.indexOf(`put ${manifestAt}`);
    const firstIndex = store.calls.findIndex((call) => call.includes('/asset-index/'));
    expect(firstIndex).toBeGreaterThan(0);
    for (const call of store.calls.slice(1, firstIndex)) {
      expect(call).toMatch(new RegExp(`^(put|head) ${ORG}/${PROJECT}/blobs/[0-9a-f]{64}$`));
    }
    for (const call of store.calls.slice(firstIndex, manifestPut)) {
      expect(call).toMatch(new RegExp(`^(put|head) ${ORG}/${PROJECT}/asset-index/assets/`));
    }

    const stored = await store.inner.get(manifestAt);
    expect(stored?.body.equals(bytes)).toBe(true);
    expect(stored?.meta).toEqual({ files: '4', bytes: String(result.totalBytes) });
    const blob = await store.inner.get(blobKey(ORG, PROJECT, sha('body{}')));
    expect(blob?.body.toString()).toBe('body{}');
    expect(blob?.meta).toEqual({ type: 'text/css' });
  });

  it('skips blobs whose head already exists', async () => {
    const store = new RecordingStore();
    await store.inner.put(blobKey(ORG, PROJECT, sha('body{}')), Buffer.from('body{}'), {
      type: 'text/css',
    });
    await upload(store, ORG, PROJECT, FILES);
    expect(store.calls).toContain(`head ${blobKey(ORG, PROJECT, sha('body{}'))}`);
    expect(store.calls).not.toContain(`put ${blobKey(ORG, PROJECT, sha('body{}'))}`);
    // Two blobs, two asset-index entries, the manifest.
    expect(store.calls.filter((call) => call.startsWith('put '))).toHaveLength(5);
  });

  it('byte-identical output uploads nothing new', async () => {
    const store = new RecordingStore();
    const first = await upload(store, ORG, PROJECT, FILES);
    const count = store.inner.objects.size;
    store.calls.length = 0;

    const again = await upload(store, ORG, PROJECT, [...FILES].reverse());
    expect(again).toEqual(first);
    expect(store.inner.objects.size).toBe(count);
    expect(store.calls.filter((call) => call.startsWith('put '))).toEqual([]);
    expect(store.calls.at(-1)).toBe(`head ${manifestKey(ORG, PROJECT, first.artifactSha)}`);
  });

  it('keeps each project in its own prefix', async () => {
    const store = new MemoryObjectStore();
    const other = '00000000-0000-4000-8000-000000000003';
    await upload(store, ORG, PROJECT, FILES);
    await upload(store, ORG, other, FILES);
    const prefixes = new Set(
      [...store.objects.keys()].map((key) => key.split('/').slice(0, 2).join('/')),
    );
    expect(prefixes).toEqual(new Set([`${ORG}/${PROJECT}`, `${ORG}/${other}`]));
  });

  it('fails when the manifest cannot be confirmed after the write', async () => {
    const store = new MemoryObjectStore();
    const lossy: ObjectStorePort = {
      put: (key, body, meta) =>
        key.endsWith('/manifest.json') ? Promise.resolve() : store.put(key, body, meta),
      get: (key) => store.get(key),
      head: (key) => store.head(key),
      delete: (key) => store.delete(key),
    };
    await expect(upload(lossy, ORG, PROJECT, FILES)).rejects.toThrow(/manifest/);
  });

  it('propagates a store failure and never writes the manifest after it', async () => {
    const store = new RecordingStore();
    const failing: ObjectStorePort = {
      put: (key, body, meta) =>
        key.includes('/blobs/')
          ? Promise.reject(new Error('store down'))
          : store.put(key, body, meta),
      get: (key) => store.get(key),
      head: (key) => store.head(key),
      delete: (key) => store.delete(key),
    };
    await expect(upload(failing, ORG, PROJECT, FILES)).rejects.toThrow('store down');
    expect(
      store.calls.some((call) => call.startsWith('put ') && call.endsWith('/manifest.json')),
    ).toBe(false);
  });
});

describe('upload: the asset index (FR-025, research R11 amendment)', () => {
  it('writes one entry per assets/ file, and none for anything else', async () => {
    const store = new MemoryObjectStore();
    await upload(store, ORG, PROJECT, [
      ...FILES,
      file('img/logo.png', 'png'),
      file('assetsx.js', 'x'),
    ]);

    const indexKeys = [...store.objects.keys()].filter((key) => key.includes('/asset-index/'));
    expect(indexKeys.sort()).toEqual([
      assetIndexKey(ORG, PROJECT, 'assets/app.js'),
      assetIndexKey(ORG, PROJECT, 'assets/style.css'),
    ]);
    expect(assetIndexKey(ORG, PROJECT, 'assets/app.js')).toBe(
      `${ORG}/${PROJECT}/asset-index/assets/app.js`,
    );
  });

  it('an entry is the canonical manifest entry, with its sha in the metadata', async () => {
    const store = new MemoryObjectStore();
    await upload(store, ORG, PROJECT, FILES);

    const entry = await store.get(assetIndexKey(ORG, PROJECT, 'assets/app.js'));
    expect(entry?.body.toString()).toBe(
      canonicalJson({ sha: sha('console.log(1)'), size: 14, type: 'text/javascript' }),
    );
    expect(entry?.meta).toEqual({ sha: sha('console.log(1)') });
  });

  it('skips an entry that already names the same blob, and overwrites one naming another', async () => {
    const store = new RecordingStore();
    const same = assetIndexKey(ORG, PROJECT, 'assets/app.js');
    const stale = assetIndexKey(ORG, PROJECT, 'assets/style.css');
    await store.inner.put(same, Buffer.from('kept'), { sha: sha('console.log(1)') });
    await store.inner.put(stale, Buffer.from('stale'), { sha: sha('old') });

    await upload(store, ORG, PROJECT, FILES);

    expect(store.calls).toContain(`head ${same}`);
    expect(store.calls).not.toContain(`put ${same}`);
    expect((await store.inner.get(same))?.body.toString()).toBe('kept');
    expect(store.calls).toContain(`put ${stale}`);
    expect((await store.inner.get(stale))?.meta).toEqual({ sha: sha('body{}') });
  });

  it('keeps the entries of an earlier release when a later one drops the path', async () => {
    const store = new MemoryObjectStore();
    await upload(store, ORG, PROJECT, [file('index.html', 'a'), file('assets/a-1.js', 'A')]);
    await upload(store, ORG, PROJECT, [file('index.html', 'b'), file('assets/b-2.js', 'B')]);

    expect(await store.head(assetIndexKey(ORG, PROJECT, 'assets/a-1.js'))).toEqual({
      meta: { sha: sha('A') },
    });
    expect(await store.head(assetIndexKey(ORG, PROJECT, 'assets/b-2.js'))).toEqual({
      meta: { sha: sha('B') },
    });
  });

  it('writes no entry when a blob write fails', async () => {
    const store = new RecordingStore();
    const failing: ObjectStorePort = {
      put: (key, body, meta) =>
        key.includes('/blobs/')
          ? Promise.reject(new Error('store down'))
          : store.put(key, body, meta),
      get: (key) => store.get(key),
      head: (key) => store.head(key),
      delete: (key) => store.delete(key),
    };
    await expect(upload(failing, ORG, PROJECT, FILES)).rejects.toThrow('store down');
    expect(store.calls.some((call) => call.includes('/asset-index/'))).toBe(false);
  });

  it('writes no manifest when an index write fails', async () => {
    const store = new RecordingStore();
    const failing: ObjectStorePort = {
      put: (key, body, meta) =>
        key.includes('/asset-index/')
          ? Promise.reject(new Error('index down'))
          : store.put(key, body, meta),
      get: (key) => store.get(key),
      head: (key) => store.head(key),
      delete: (key) => store.delete(key),
    };
    await expect(upload(failing, ORG, PROJECT, FILES)).rejects.toThrow('index down');
    expect(
      store.calls.some((call) => call.startsWith('put ') && call.endsWith('/manifest.json')),
    ).toBe(false);
  });
});
