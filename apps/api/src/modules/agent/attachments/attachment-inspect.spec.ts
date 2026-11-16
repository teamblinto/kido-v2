import { MAX_EXTRACTED_TEXT_CHARS } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { buildZip } from '../../../../test/fixtures/zip-fixture';
import { AttachmentRejectedError } from './attachment.errors';
import { inspectAttachment } from './attachment-inspect';

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(16)]);

describe('inspectAttachment', () => {
  /** SC-1. */
  it('refuses a .png holding a PE header', () => {
    const pe = Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(64)]);

    expect(() => inspectAttachment('logo.png', pe)).toThrow(AttachmentRejectedError);
  });

  it('takes a real PNG as an image with no extracted text', () => {
    expect(inspectAttachment('Logo.PNG', PNG)).toEqual({
      extractedText: null,
      kind: 'image',
      mimeType: 'image/png',
    });
  });

  it('refuses an extension off the allowlist before looking at the bytes', () => {
    expect(() => inspectAttachment('setup.exe', PNG)).toThrow(AttachmentRejectedError);
    expect(() => inspectAttachment('README', Buffer.from('hi'))).toThrow(AttachmentRejectedError);
  });

  it('takes SVG as text, never as an image', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';

    expect(inspectAttachment('icon.svg', Buffer.from(svg))).toEqual({
      extractedText: svg,
      kind: 'text',
      mimeType: 'image/svg+xml',
    });
  });

  it('strips a BOM and caps the text', () => {
    const long = String.fromCharCode(0xfeff) + 'a'.repeat(MAX_EXTRACTED_TEXT_CHARS + 10);
    const { extractedText } = inspectAttachment('notes.md', Buffer.from(long));

    expect(extractedText).toHaveLength(MAX_EXTRACTED_TEXT_CHARS);
    expect(extractedText?.startsWith('a')).toBe(true);
  });

  it('refuses text that is not UTF-8, or that carries NUL', () => {
    expect(() => inspectAttachment('data.csv', Buffer.from([0x61, 0xff, 0xfe, 0x62]))).toThrow(
      /UTF-8/,
    );
    expect(() => inspectAttachment('main.ts', Buffer.from('a\u0000b'))).toThrow(/UTF-8/);
  });

  it('extracts a DOCX’s paragraphs, decoding entities and dropping tags', () => {
    const xml =
      '<?xml version="1.0"?><w:document><w:body>' +
      '<w:p><w:r><w:t>Tom &amp; Jerry</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>a&lt;b</w:t><w:tab/><w:t>&#8364;5</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const docx = buildZip([
      { data: '<Types/>', name: '[Content_Types].xml' },
      { data: xml, name: 'word/document.xml' },
    ]);

    expect(inspectAttachment('brief.docx', docx)).toEqual({
      extractedText: 'Tom & Jerry\na<b\t€5',
      kind: 'document',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('strips NUL and other C0 controls from a DOCX’s text, keeping tabs and newlines', () => {
    const xml =
      '<w:document><w:p><w:t>a\u0000b\u0007c&#1;d</w:t><w:tab/><w:t>e\rf</w:t></w:p>' +
      '<w:p><w:t>g</w:t></w:p></w:document>';
    const docx = buildZip([{ data: xml, name: 'word/document.xml' }]);

    expect(inspectAttachment('x.docx', docx).extractedText).toBe('abcd\te\rf\ng');
  });

  it('refuses a DOCX whose document XML inflates past 8 MiB', () => {
    const xml = `<w:document><w:p><w:t>${'a'.repeat(8 * 1024 * 1024)}</w:t></w:p></w:document>`;
    const docx = buildZip([{ data: xml, method: 0, name: 'word/document.xml' }]);

    expect(() => inspectAttachment('big.docx', docx)).toThrow(AttachmentRejectedError);
  });

  it('refuses a DOCX with no document in it', () => {
    expect(() => inspectAttachment('x.docx', buildZip([{ data: 'x', name: 'a.txt' }]))).toThrow(
      /not a Word document/,
    );
  });

  it('lists a ZIP and inlines its small text entries, never its binaries', () => {
    const zip = buildZip([
      { data: 'export const a = 1;\n', name: 'src/a.ts' },
      { data: PNG, name: 'img/logo.png' },
      { data: '', method: 0, name: 'empty/' },
      { data: 'ok', name: 'evil\u0007name.txt' },
    ]);
    const result = inspectAttachment('project.zip', zip);

    expect(result.kind).toBe('archive');
    expect(result.extractedText).toBe(
      'Archive with 3 file(s):\n' +
        'src/a.ts (20 bytes)\n' +
        `img/logo.png (${String(PNG.length)} bytes)\n` +
        'evilname.txt (2 bytes)\n' +
        '\n--- src/a.ts ---\nexport const a = 1;\n\n' +
        '\n--- evilname.txt ---\nok\n',
    );
  });

  it('refuses an archive the reader will not open', () => {
    expect(() =>
      inspectAttachment('x.zip', buildZip([{ data: 'x', flags: 0x1, name: 'a.txt' }])),
    ).toThrow(AttachmentRejectedError);
  });
});
