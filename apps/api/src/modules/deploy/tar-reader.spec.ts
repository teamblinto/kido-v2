import { describe, expect, it } from 'vitest';

import { readTar, TarRefused, type TarLimits } from './tar-reader';

/**
 * Hand-built ustar fixtures (research R5). No tar dependency and no `tar` binary: each header is
 * laid out byte by byte here, so the spec says exactly what the reader is shown.
 */

const BLOCK = 512;
const MIB = 1024 * 1024;
const LIMITS: TarLimits = { maxFiles: 10_000, maxBytes: 100 * MIB };

interface Entry {
  name: string;
  type?: string;
  body?: Buffer | string;
  /** Overrides the size field, for headers that lie about what follows. */
  size?: number;
  prefix?: string;
  magic?: 'posix' | 'gnu' | 'v7';
  checksum?: number;
  /** Raw size field, for malformed-number cases. */
  sizeField?: string;
}

function field(target: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, 'utf8').copy(target, offset, 0, length);
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(entry: Entry): Buffer {
  const body = toBuffer(entry.body);
  const block = Buffer.alloc(BLOCK);
  field(block, 0, 100, entry.name);
  field(block, 100, 8, octal(0o644, 8));
  field(block, 108, 8, octal(0, 8));
  field(block, 116, 8, octal(0, 8));
  field(block, 124, 12, entry.sizeField ?? octal(entry.size ?? body.length, 12));
  field(block, 136, 12, octal(0, 12));
  field(block, 156, 1, entry.type ?? '0');
  const magic = entry.magic ?? 'posix';
  if (magic === 'posix') {
    field(block, 257, 6, 'ustar\0');
    field(block, 263, 2, '00');
  } else if (magic === 'gnu') {
    field(block, 257, 8, 'ustar  \0');
  }
  if (entry.prefix !== undefined) field(block, 345, 155, entry.prefix);
  field(block, 148, 8, '        ');
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, 148, 8, octal(entry.checksum ?? sum, 7) + ' ');
  return block;
}

function toBuffer(body: Buffer | string | undefined): Buffer {
  if (body === undefined) return Buffer.alloc(0);
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
}

function padded(body: Buffer): Buffer {
  const rest = body.length % BLOCK;
  return rest === 0 ? body : Buffer.concat([body, Buffer.alloc(BLOCK - rest)]);
}

function member(entry: Entry): Buffer {
  return Buffer.concat([header(entry), padded(toBuffer(entry.body))]);
}

const END = Buffer.alloc(BLOCK * 2);

function archive(...entries: Entry[]): Buffer {
  return Buffer.concat([...entries.map(member), END]);
}

function pax(records: Record<string, string>, type = 'x'): Entry {
  const body = Object.entries(records)
    .map(([key, value]) => {
      const text = ` ${key}=${value}\n`;
      let length = Buffer.byteLength(text) + 1;
      while (String(length).length + Buffer.byteLength(text) !== length) length += 1;
      return `${length}${text}`;
    })
    .join('');
  return { name: 'PaxHeaders/x', type, body };
}

function refusal(run: () => unknown): TarRefused {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TarRefused);
    return error as TarRefused;
  }
  throw new Error('expected readTar to refuse');
}

function paths(buffer: Buffer): string[] {
  return readTar(buffer, LIMITS).files.map((file) => file.path);
}

describe('readTar — what it keeps', () => {
  it("keeps regular files, including the '\\0' type flag, with their bytes", () => {
    const result = readTar(
      archive(
        { name: './index.html', body: '<h1>hi</h1>' },
        { name: './legacy.txt', type: '\0', body: 'old' },
      ),
      LIMITS,
    );
    expect(result.files).toEqual([
      { path: 'index.html', body: Buffer.from('<h1>hi</h1>') },
      { path: 'legacy.txt', body: Buffer.from('old') },
    ]);
    expect(result.totalBytes).toBe(14);
    expect(result.dropped).toBe(0);
  });

  it('reads bodies spanning several blocks and the GNU magic', () => {
    const big = Buffer.alloc(BLOCK * 2 + 7, 0x61);
    const result = readTar(
      archive({ name: 'a.bin', body: big, magic: 'gnu' }, { name: 'b.txt', body: 'b' }),
      LIMITS,
    );
    expect(result.files.map((file) => file.body.length)).toEqual([big.length, 1]);
    expect(result.files[0]?.body.equals(big)).toBe(true);
  });

  it('skips directories', () => {
    expect(
      paths(
        archive(
          { name: './', type: '5' },
          { name: './assets/', type: '5' },
          { name: './assets/app.js', body: 'x' },
        ),
      ),
    ).toEqual(['assets/app.js']);
  });

  it('drops symlinks, hard links, char and block devices and FIFOs, and counts them', () => {
    const result = readTar(
      archive(
        { name: 'index.html', body: 'ok' },
        { name: 'sym', type: '2' },
        { name: 'hard', type: '1' },
        { name: 'chr', type: '3' },
        { name: 'blk', type: '4' },
        { name: 'fifo', type: '6' },
        { name: 'contiguous', type: '7', body: 'data' },
      ),
      LIMITS,
    );
    expect(result.files.map((file) => file.path)).toEqual(['index.html']);
    expect(result.dropped).toBe(6);
  });

  it('joins the POSIX prefix field to the name', () => {
    expect(paths(archive({ name: 'app.js', prefix: 'assets/deep', body: 'x' }))).toEqual([
      'assets/deep/app.js',
    ]);
  });

  it('ignores the prefix bytes under GNU magic, where they mean something else', () => {
    expect(paths(archive({ name: 'app.js', prefix: 'junk', magic: 'gnu', body: 'x' }))).toEqual([
      'app.js',
    ]);
  });
});

describe('readTar — long names', () => {
  const long = `assets/${'n'.repeat(150)}.js`;

  it("honours an 'x' pax path for the next entry only", () => {
    expect(
      paths(
        archive(
          pax({ mtime: '1', path: `./${long}` }),
          { name: 'truncated', body: 'x' },
          { name: 'after.txt', body: 'y' },
        ),
      ),
    ).toEqual([long, 'after.txt']);
  });

  it('a pax header without a path leaves the ustar name alone', () => {
    expect(paths(archive(pax({ mtime: '1' }), { name: 'short.txt', body: 'x' }))).toEqual([
      'short.txt',
    ]);
  });

  it("honours an 'L' GNU long name, NUL-terminated, for the next entry only", () => {
    expect(
      paths(
        archive(
          { name: '././@LongLink', type: 'L', body: `./${long}\0`, magic: 'gnu' },
          { name: 'truncated', body: 'x', magic: 'gnu' },
          { name: 'after.txt', body: 'y', magic: 'gnu' },
        ),
      ),
    ).toEqual([long, 'after.txt']);
  });

  it("takes an 'L' body with no NUL terminator whole", () => {
    expect(
      paths(archive({ name: 'L', type: 'L', body: 'no-terminator.txt' }, { name: 'x', body: 'y' })),
    ).toEqual(['no-terminator.txt']);
  });

  it("an 'L' name applied to a dropped link is spent, not carried to the next file", () => {
    const result = readTar(
      archive(
        { name: '././@LongLink', type: 'L', body: 'evil\0' },
        { name: '././@LongLink', type: 'K', body: '/etc/passwd\0' },
        { name: 'x', type: '2' },
        { name: 'real.txt', body: 'y' },
      ),
      LIMITS,
    );
    expect(result.files.map((file) => file.path)).toEqual(['real.txt']);
    expect(result.dropped).toBe(1);
  });

  it("ignores 'g' global pax headers, including a path in them", () => {
    expect(
      paths(archive(pax({ path: 'global.txt' }, 'g'), { name: 'own.txt', body: 'x' })),
    ).toEqual(['own.txt']);
  });

  it('refuses a malformed pax record', () => {
    for (const body of ['nonsense', '5 a=b\n', '99 path=x\n', '6 ab\n\n']) {
      const error = refusal(() =>
        readTar(archive({ name: 'p', type: 'x', body }, { name: 'f', body: 'x' }), LIMITS),
      );
      expect(error.reason).toBe('malformed');
    }
  });

  it('refuses a long-name header whose body is itself over the cap', () => {
    const error = refusal(() =>
      readTar(archive({ name: 'L', type: 'L', body: 'a'.repeat(70_000) }), LIMITS),
    );
    expect(error.reason).toBe('malformed');
  });
});

describe('readTar — path rules', () => {
  const bad: [string, Entry[]][] = [
    ['an absolute path', [{ name: '/etc/passwd', body: 'x' }]],
    ['a .. segment', [{ name: './../../escape', body: 'x' }]],
    ['a .. segment in the middle', [{ name: 'a/../../b', body: 'x' }]],
    ['a backslash', [{ name: 'a\\b.txt', body: 'x' }]],
    ['a NUL from a pax path', [pax({ path: 'a\0b' }), { name: 'f', body: 'x' }]],
    ['an absolute pax path', [pax({ path: '/abs' }), { name: 'f', body: 'x' }]],
    ['an empty segment', [{ name: 'a//b', body: 'x' }]],
    ['a . segment', [{ name: 'a/./b', body: 'x' }]],
    ['a trailing slash on a file', [{ name: 'dir/', body: 'x' }]],
    ['an empty name', [{ name: '', body: 'x' }]],
    ['the root itself as a file', [{ name: './', body: 'x' }]],
    ['a path over 1024 bytes', [pax({ path: 'a'.repeat(1025) }), { name: 'f', body: 'x' }]],
    [
      'a duplicate path',
      [
        { name: 'index.html', body: 'a' },
        { name: './index.html', body: 'b' },
      ],
    ],
  ];

  it.each(bad)('refuses %s', (_label, entries) => {
    const error = refusal(() => readTar(archive(...entries), LIMITS));
    expect(error.reason).toBe('malformed');
    expect(error.message).toMatch(/path/);
  });

  it('strips any number of leading ./ and accepts 1024 bytes exactly', () => {
    const exact = 'a'.repeat(1024);
    expect(
      paths(archive({ name: '././x.txt', body: 'x' }, pax({ path: exact }), { name: 'f' })),
    ).toEqual(['x.txt', exact]);
  });
});

describe('readTar — limits', () => {
  it('stops with output-too-large at 10,001 files', () => {
    const entries = Array.from({ length: 10_001 }, (_, index) => ({ name: `f${index}` }));
    const error = refusal(() => readTar(archive(...entries), LIMITS));
    expect(error.reason).toBe('output-too-large');
    expect(readTar(archive(...entries.slice(0, 10_000)), LIMITS).files).toHaveLength(10_000);
  });

  it('stops with output-too-large past 100 MiB, from the header, before reading the body', () => {
    // A header that claims 100 MiB + 1 and is followed by nothing: the refusal comes from the
    // size field, not from running off the end.
    const buffer = header({ name: 'huge.bin', size: 100 * MIB + 1 });
    expect(refusal(() => readTar(buffer, LIMITS)).reason).toBe('output-too-large');
  });

  it('counts bytes across files, and 100 MiB exactly is allowed', () => {
    const limits: TarLimits = { maxFiles: 10, maxBytes: 10 };
    expect(
      readTar(archive({ name: 'a', body: '12345' }, { name: 'b', body: '12345' }), limits)
        .totalBytes,
    ).toBe(10);
    const error = refusal(() =>
      readTar(
        Buffer.concat([
          member({ name: 'a', body: '12345' }),
          header({ name: 'b', size: 6 }),
          // no body: the refusal must not need it
        ]),
        limits,
      ),
    );
    expect(error.reason).toBe('output-too-large');
  });

  it('dropped entries and directories do not count towards the file cap', () => {
    const limits: TarLimits = { maxFiles: 1, maxBytes: 10 };
    expect(
      readTar(
        archive({ name: 'd/', type: '5' }, { name: 's', type: '2' }, { name: 'd/f', body: 'x' }),
        limits,
      ).files,
    ).toHaveLength(1);
  });

  it('refuses a size field too large to be octal (base-256) as output-too-large', () => {
    const buffer = header({ name: 'x', sizeField: '\x80' + '\0'.repeat(11) });
    expect(refusal(() => readTar(buffer, LIMITS)).reason).toBe('output-too-large');
  });
});

describe('readTar — malformed archives', () => {
  it('refuses a truncated body', () => {
    const whole = archive({ name: 'a.txt', body: 'x'.repeat(1000) });
    const error = refusal(() => readTar(whole.subarray(0, BLOCK + 100), LIMITS));
    expect(error.reason).toBe('malformed');
    expect(error.message).toMatch(/truncated/);
  });

  it('refuses a partial header block', () => {
    const whole = archive({ name: 'a.txt', body: 'x' });
    expect(refusal(() => readTar(whole.subarray(0, BLOCK * 2 + 100), LIMITS)).message).toMatch(
      /truncated/,
    );
  });

  it('refuses an archive with no end-of-archive block', () => {
    expect(refusal(() => readTar(member({ name: 'a.txt', body: 'x' }), LIMITS)).message).toMatch(
      /truncated/,
    );
  });

  it('refuses a metadata header with nothing after it', () => {
    const buffer = Buffer.concat([member(pax({ path: 'x' })), END]);
    expect(refusal(() => readTar(buffer, LIMITS)).message).toMatch(/truncated|dangling/);
  });

  it('refuses a bad header checksum', () => {
    const error = refusal(() =>
      readTar(archive({ name: 'a.txt', body: 'x', checksum: 1 }), LIMITS),
    );
    expect(error.reason).toBe('malformed');
    expect(error.message).toMatch(/checksum/);
  });

  it('refuses a header without ustar magic', () => {
    expect(
      refusal(() => readTar(archive({ name: 'a.txt', body: 'x', magic: 'v7' }), LIMITS)).message,
    ).toMatch(/magic/);
  });

  it('reads an all-NUL size field as zero', () => {
    expect(
      readTar(archive({ name: 'empty.txt', sizeField: '\0'.repeat(12) }), LIMITS).files,
    ).toEqual([{ path: 'empty.txt', body: Buffer.alloc(0) }]);
  });

  it('refuses a size field that is not octal', () => {
    expect(
      refusal(() => readTar(archive({ name: 'a.txt', sizeField: '00000000009\0' }), LIMITS)).reason,
    ).toBe('malformed');
  });

  it('ignores whatever follows the end-of-archive blocks', () => {
    const buffer = Buffer.concat([archive({ name: 'a.txt', body: 'x' }), Buffer.from('trailing')]);
    expect(readTar(buffer, LIMITS).files).toHaveLength(1);
  });
});

describe('readTar — no output', () => {
  it('returns no-output for an empty archive', () => {
    expect(refusal(() => readTar(END, LIMITS)).reason).toBe('no-output');
  });

  it('returns no-output for zero bytes', () => {
    expect(refusal(() => readTar(Buffer.alloc(0), LIMITS)).reason).toBe('no-output');
  });

  it('returns no-output when there are only directories and dropped links', () => {
    expect(
      refusal(() => readTar(archive({ name: './', type: '5' }, { name: 'l', type: '2' }), LIMITS))
        .reason,
    ).toBe('no-output');
  });
});
