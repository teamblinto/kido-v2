import { describe, expect, it } from 'vitest';

import { buildZip } from '../../../../test/fixtures/zip-fixture';
import { DEFAULT_ZIP_LIMITS, openZip, ZipError } from './zip-reader';

describe('openZip', () => {
  it('lists stored and deflated entries and reads them back', () => {
    const archive = openZip(
      buildZip([
        { data: 'hello', method: 0, name: 'a.txt' },
        { data: 'deflated '.repeat(50), name: 'src/b.ts' },
        { data: '', method: 0, name: 'src/' },
      ]),
    );

    expect(archive.entries.map((entry) => [entry.name, entry.size, entry.directory])).toEqual([
      ['a.txt', 5, false],
      ['src/b.ts', 450, false],
      ['src/', 0, true],
    ]);
    expect(archive.read(archive.entries[0]!).toString()).toBe('hello');
    expect(archive.read(archive.entries[1]!).toString()).toBe('deflated '.repeat(50));
  });

  /** SC-3: refused from the declared sizes, before a byte is inflated. */
  it('refuses a bomb by its compression ratio', () => {
    const bomb = buildZip([{ data: Buffer.alloc(10 * 1024 * 1024), name: 'zeros.bin' }]);

    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => openZip(bomb)).toThrow(/expands too far/);
  });

  it('refuses an archive whose declared total passes the cap', () => {
    const many = buildZip(
      Array.from({ length: 3 }, (_, index) => ({
        data: 'x',
        method: 0,
        name: `f${String(index)}`,
        size: 1,
      })),
    );

    expect(() => openZip(many, { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 2 })).toThrow(
      /expands too far/,
    );
  });

  /** A header that understates the size cannot smuggle a bomb past the ratio check. */
  it('stops inflating at the declared size when the header lies', () => {
    const archive = openZip(
      buildZip([{ data: Buffer.alloc(5 * 1024 * 1024), name: 'liar.bin', size: 100 }]),
    );

    expect(() => archive.read(archive.entries[0]!)).toThrow(ZipError);
  });

  it('caps what one archive inflates across reads', () => {
    const archive = openZip(
      buildZip([
        { data: 'a'.repeat(100), name: 'one.txt' },
        { data: 'b'.repeat(100), name: 'two.txt' },
      ]),
      { ...DEFAULT_ZIP_LIMITS, maxTotalReadBytes: 150 },
    );

    archive.read(archive.entries[0]!);
    expect(() => archive.read(archive.entries[1]!)).toThrow(/expands too far/);
  });

  it('refuses too many entries', () => {
    const zip = buildZip([
      { data: 'a', name: 'a' },
      { data: 'b', name: 'b' },
    ]);

    expect(() => openZip(zip, { ...DEFAULT_ZIP_LIMITS, maxEntries: 1 })).toThrow(/too many/);
  });

  it('refuses encrypted entries', () => {
    expect(() => openZip(buildZip([{ data: 'secret', flags: 0x1, name: 'a.txt' }]))).toThrow(
      /Encrypted/,
    );
  });

  it('refuses an unknown compression method', () => {
    expect(() => openZip(buildZip([{ data: 'x', method: 12, name: 'a.bz2' }]))).toThrow(
      /compression method/,
    );
  });

  it('refuses a truncated archive and offsets outside the buffer', () => {
    const zip = buildZip([{ data: 'hello world', name: 'a.txt' }]);

    expect(() => openZip(zip.subarray(0, zip.length - 30))).toThrow(ZipError);

    const outOfBounds = Buffer.from(zip);
    // The end record's central-directory offset, pointed past the end of the file.
    outOfBounds.writeUInt32LE(0x7fffffff, outOfBounds.length - 6);
    expect(() => openZip(outOfBounds)).toThrow(/corrupt/);

    const badLocal = Buffer.from(zip);
    const central = badLocal.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    // The entry's local-header offset, pointed into the central directory itself.
    badLocal.writeUInt32LE(central, central + 42);
    expect(() => openZip(badLocal)).toThrow(/corrupt/);
  });

  it('refuses what is not a ZIP at all', () => {
    expect(() => openZip(Buffer.from('MZ not an archive'))).toThrow(/not a ZIP/);
    expect(() => openZip(Buffer.alloc(0))).toThrow(/not a ZIP/);
  });
});
