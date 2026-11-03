import { LOCAL_AGENT_MAX_COMMAND_CHARS } from '@repo/contracts';

/**
 * An incremental `text/event-stream` parser (WHATWG HTML § 9.2.6): CR, LF and CRLF line endings
 * (a CRLF may straddle chunks), a leading BOM, `:` comments, multi-line `data:`, and `id:` that
 * persists across events for `Last-Event-ID`. An event over `maxEventChars` is never buffered: it
 * comes out empty and `oversized`, with its id, so the caller skips past it instead of
 * reconnecting into it again.
 */

export interface SseEvent {
  data: string;
  event: string;
  id: string;
  /** Too large to keep; `data` is empty. */
  oversized?: true;
}

export class SseParser {
  /** The last `id:` seen; sent back as `Last-Event-ID` on reconnect. */
  lastEventId = '';
  /** Server-suggested reconnect delay, when it sent `retry:`. */
  retryMs: number | null = null;
  private buffer = '';
  private data: string[] = [];
  private dataSize = 0;
  /** Dropping the rest of an over-long line (the buffer holds `:`, so it ends as a comment). */
  private discarding = false;
  private eventType = '';
  private idBuffer: string;
  private readonly maxEventChars: number;
  private oversized = false;
  private started = false;

  constructor(lastEventId = '', maxEventChars = LOCAL_AGENT_MAX_COMMAND_CHARS) {
    this.lastEventId = lastEventId;
    this.idBuffer = lastEventId;
    this.maxEventChars = maxEventChars;
  }

  feed(chunk: string): SseEvent[] {
    let rest = chunk;
    if (this.discarding) {
      const end = rest.search(/[\r\n]/);
      if (end === -1) return [];
      this.discarding = false;
      rest = rest.slice(end);
    }
    let text = this.buffer + rest;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.startsWith('﻿')) text = text.slice(1);
    }
    const events: SseEvent[] = [];
    const breaks = /\r\n|\r|\n/g;
    let position = 0;
    for (let match = breaks.exec(text); match; match = breaks.exec(text)) {
      // A lone CR at the end may be the first half of a CRLF; wait for the next chunk.
      if (match[0] === '\r' && match.index === text.length - 1) break;
      this.line(text.slice(position, match.index), events);
      position = match.index + match[0].length;
    }
    this.buffer = text.slice(position);
    if (this.buffer.length > this.maxEventChars) {
      this.buffer = ':';
      this.discarding = true;
      this.oversized = true;
    }
    return events;
  }

  private line(line: string, events: SseEvent[]): void {
    if (line === '') {
      // The id only counts once its event is complete, so a cut-off event is asked for again.
      this.lastEventId = this.idBuffer;
      const event = this.eventType || 'message';
      if (this.oversized) {
        events.push({ data: '', event, id: this.lastEventId, oversized: true });
      } else if (this.data.length > 0) {
        events.push({ data: this.data.join('\n'), event, id: this.lastEventId });
      }
      this.data = [];
      this.dataSize = 0;
      this.eventType = '';
      this.oversized = false;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.dataSize += value.length;
        if (this.dataSize > this.maxEventChars) {
          this.oversized = true;
          this.data = [];
        } else if (!this.oversized) {
          this.data.push(value);
        }
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.idBuffer = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break;
    }
  }
}
