import { SseParser } from './sse.ts';

describe('SseParser', () => {
  it('parses events, ids and multi-line data, and skips comments', () => {
    const parser = new SseParser();
    const events = parser.feed(
      ':heartbeat\n\nid: 7\nevent: command\ndata: {"a":1}\ndata: line2\n\n',
    );
    expect(events).toEqual([{ data: '{"a":1}\nline2', event: 'command', id: '7' }]);
    expect(parser.lastEventId).toBe('7');
  });

  it('handles CRLF split across chunks, bare CR, and a leading BOM', () => {
    const parser = new SseParser();
    expect(parser.feed('﻿data: one\r')).toEqual([]);
    expect(parser.feed('\n\r\ndata: two\r\r')).toEqual([{ data: 'one', event: 'message', id: '' }]);
    // The trailing CR is held until the next chunk shows it is not half of a CRLF.
    expect(parser.feed(':\n')).toEqual([{ data: 'two', event: 'message', id: '' }]);
  });

  it('assembles an event delivered one character at a time', () => {
    const parser = new SseParser();
    const text = 'id: 3\ndata: hello\n\n';
    const events = [...text].flatMap((char) => parser.feed(char));
    expect(events).toEqual([{ data: 'hello', event: 'message', id: '3' }]);
  });

  it('commits an id only when its event completes, so a cut-off event is asked for again', () => {
    const parser = new SseParser('4');
    expect(parser.feed('id: 5\ndata: partial')).toEqual([]);
    expect(parser.lastEventId).toBe('4');
  });

  it('keeps the id across events, ignores ids with NUL, and strips one leading space', () => {
    const parser = new SseParser();
    const events = parser.feed('id: 1\ndata:  two spaces\n\ndata:x\n\nid: bad\0id\ndata: y\n\n');
    expect(events.map((event) => [event.id, event.data])).toEqual([
      ['1', ' two spaces'],
      ['1', 'x'],
      ['1', 'y'],
    ]);
  });

  it('ignores events without data, unknown fields and fields without a colon, and reads retry', () => {
    const parser = new SseParser();
    expect(parser.feed('event: ping\n\nfoo: bar\ndata\nretry: 2500\n\n')).toEqual([
      { data: '', event: 'message', id: '' },
    ]);
    expect(parser.retryMs).toBe(2500);
  });

  it('skips an oversized event, streamed in pieces, past its id instead of failing (L6)', () => {
    const parser = new SseParser('', 20);
    const events = [
      'id: 1\ndata: ',
      'x'.repeat(15),
      'y'.repeat(15),
      'z'.repeat(15),
      '\r',
      '\n\r\nid: 2\ndata: ok\n\n',
    ].flatMap((chunk) => parser.feed(chunk));
    expect(events).toEqual([
      { data: '', event: 'message', id: '1', oversized: true },
      { data: 'ok', event: 'message', id: '2' },
    ]);
    expect(parser.lastEventId).toBe('2');
  });

  it('skips an event whose many data lines add up past the cap', () => {
    const parser = new SseParser('', 20);
    const lines = Array.from({ length: 5 }, () => `data: ${'a'.repeat(8)}`).join('\n');
    expect(parser.feed(`id: 9\n${lines}\n\ndata: next\n\n`)).toEqual([
      { data: '', event: 'message', id: '9', oversized: true },
      { data: 'next', event: 'message', id: '9' },
    ]);
  });
});
