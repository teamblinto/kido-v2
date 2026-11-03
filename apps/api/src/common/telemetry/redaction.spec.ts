import { pinoHttp } from 'pino-http';
import { Writable } from 'node:stream';

import { REDACTED_PATHS, REDACTION_CENSOR } from './redaction';
import { scrubLogLine } from './scrubber';

function captureOneLine(log: (logger: ReturnType<typeof pinoHttp>['logger']) => void): unknown {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });

  const http = pinoHttp(
    { level: 'trace', redact: { censor: REDACTION_CENSOR, paths: [...REDACTED_PATHS] } },
    sink,
  );

  log(http.logger);

  return JSON.parse(lines[0] ?? '{}');
}

describe('redaction paths', () => {
  /**
   * The two paths the logger shipped with. A later edit that reorganises the list must not quietly
   * drop them — they are the only reason an `Authorization` header has never reached a log file.
   */
  it.each(['req.headers.authorization', 'req.headers.cookie'])('still covers %s', (path) => {
    expect(REDACTED_PATHS).toContain(path);
  });

  it.each([
    'req.headers["proxy-authorization"]',
    'req.headers["x-api-key"]',
    'res.headers["set-cookie"]',
  ])('covers %s', (path) => {
    expect(REDACTED_PATHS).toContain(path);
  });

  // Spec 041: the one-time Claude sign-in code, by position and, should it escape that, by key name.
  it('censors the sign-in code in a request body, by path and by the scrubber', () => {
    const code = 'Qx7_sign-in.code#Z9aaaaaaaaaaaa';
    const line = captureOneLine((logger) => {
      logger.info({ req: { body: { code } } }, 'request');
    });
    expect(JSON.stringify(line)).not.toContain(code);
    expect(scrubLogLine(JSON.stringify({ body: { code } }))).not.toContain(code);
  });

  it('lists every path exactly once', () => {
    expect(new Set(REDACTED_PATHS).size).toBe(REDACTED_PATHS.length);
  });

  /**
   * pino validates `redact.paths` when the logger is constructed and throws on a malformed entry —
   * a quoted segment with an unbalanced bracket, a wildcard in a position it does not support. A
   * typo in this list would therefore take the whole API down at boot rather than log unredacted,
   * so the list is worth proving against the real parser rather than by eye.
   */
  it('is accepted by pino as written', () => {
    expect(() => captureOneLine((logger) => logger.info('ok'))).not.toThrow();
  });

  it('censors a redacted path with the shared censor string', () => {
    const line = captureOneLine((logger) => {
      logger.info({ req: { headers: { cookie: '__Host-forge_session=abc' } } }, 'request');
    });

    expect(line).toMatchObject({ req: { headers: { cookie: REDACTION_CENSOR } } });
  });

  /**
   * pino's `res` serialiser reads headers off `getHeaders()`, so a plain object asserts nothing
   * here — it serialises to `{ statusCode: null }` and the path never matches. The double carries
   * the two members the serialiser actually reads, which is what makes `res.headers["set-cookie"]`
   * a path that does work rather than a line of decoration.
   */
  it('censors a bracketed header path', () => {
    const response = {
      getHeaders: () => ({ 'set-cookie': '__Host-forge_session=abc' }),
      headersSent: true,
      statusCode: 200,
    };

    const line = captureOneLine((logger) => {
      logger.info({ res: response }, 'response');
    });

    expect(line).toMatchObject({ res: { headers: { 'set-cookie': REDACTION_CENSOR } } });
  });

  it('leaves an unrelated header alone', () => {
    const line = captureOneLine((logger) => {
      logger.info({ req: { headers: { 'user-agent': 'vitest' } } }, 'request');
    });

    expect(line).toMatchObject({ req: { headers: { 'user-agent': 'vitest' } } });
  });
});
