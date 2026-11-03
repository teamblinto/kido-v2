import { scrubSecrets } from '../../common/telemetry/scrubber';
import { LOG_TAIL_MAX_BYTES } from './deploy.constants';

/**
 * Raw bytes kept beyond the cap, so a secret the cap would cut through is still whole when it is
 * scrubbed (a PEM block is the longest shape; a 4096-bit key is about 3.3 KiB).
 */
const SCRUB_MARGIN_BYTES = 8 * 1024;

/**
 * What `deployments.log_tail` stores (spec 027 FR-013): known secret shapes scrubbed through
 * `scrubSecrets` first — a scrub can shorten or lengthen a line, and a secret straddling the cut
 * must be matched whole — then the last `max` UTF-8 bytes, cut on a character boundary.
 * Idempotent, so a tail that is already stored passes through unchanged.
 */
export function logTail(raw: string, max = LOG_TAIL_MAX_BYTES): string {
  return lastUtf8Bytes(scrubSecrets(raw), max);
}

/** The longest suffix of `text` whose UTF-8 encoding is at most `max` bytes. */
function lastUtf8Bytes(text: string, max: number): string {
  const whole = Buffer.from(text, 'utf8');
  if (whole.length <= max) return text;

  let start = whole.length - max;
  // Continuation bytes are 10xxxxxx: step forward to the next character's first byte.
  while (start < whole.length && ((whole[start] ?? 0) & 0xc0) === 0x80) start++;
  return whole.subarray(start).toString('utf8');
}

/**
 * The combined install and build output as a build runs, holding only what the tail can need:
 * whole chunks are dropped from the front once the rest alone covers the cap plus the scrub
 * margin. `text()` is `logTail` of everything appended.
 */
export class LogBuffer {
  private chunks: string[] = [];
  private bytes = 0;

  /** A command's output, newline-terminated; empty output adds nothing. */
  append(output: string): void {
    if (output === '') return;
    this.push(output.endsWith('\n') ? output : `${output}\n`);
  }

  /** One line of the worker's own, returning the tail so far. */
  note(line: string): string {
    this.push(`${line}\n`);
    return this.text();
  }

  text(): string {
    return logTail(this.chunks.join(''));
  }

  private push(chunk: string): void {
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    while (this.chunks.length > 1) {
      const first = Buffer.byteLength(this.chunks[0] ?? '', 'utf8');
      if (this.bytes - first < LOG_TAIL_MAX_BYTES + SCRUB_MARGIN_BYTES) break;
      this.chunks.shift();
      this.bytes -= first;
    }
  }
}
