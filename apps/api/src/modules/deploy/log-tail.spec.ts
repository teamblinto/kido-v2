import { describe, expect, it } from 'vitest';

import { SECRET_SHAPES } from '../../common/telemetry/scrubber';
import { LOG_TAIL_MAX_BYTES } from './deploy.constants';
import { LogBuffer, logTail } from './log-tail';

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** One sample per `SECRET_SHAPES` rule name, each well above its rule's threshold. */
const SAMPLES: Readonly<Record<string, string>> = {
  'aws-key': 'AKIAIOSFODNN7EXAMPLE',
  bearer: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
  cookie: 'Cookie: __Host-forge_session=s3cr3tSessionValue0123',
  'daytona-key': `dtn_${'0a'.repeat(32)}`,
  'github-token': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'password-hash': '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG',
  pem: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----',
  'provider-key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  'query-credential': 'GET /verify?token=abcdef0123456789abcdef',
  'slack-token': 'xoxb-1234567890-abcdefghijkl',
  'url-credential': 'https://deploy:hunter2hunter2@registry.example.test/pkg',
  'resend-key': 're_4kQz9Xw2Lm7Pv3Rt8Ny5Bc1D',
  'supabase-key': 'sb_secret_Hq7Lw2Mz9Kx4Pt6Rv1Nb8C',
  'netlify-token': 'nfp_Q7mZ2xK9pW4rT8vN3bL6cY1dF5',
  'neon-key': 'napi_k3m9x2q7w4p8r1t6v5n0b3l7c2',
  'local-agent-token': 'bld_Zx8Qm2Lw7Rt4Kp9Vn3Bc6Yd1Fg5Hj0Ss2Aa4Ee6Ii8O',
  'local-agent-pairing-code': 'GET /api/v1/me/local-agents/pairings/BCDF-GHJK 200',
};

/** The part of each sample that must never reach storage. */
const SECRET_PART: Readonly<Record<string, string>> = {
  'aws-key': 'IOSFODNN7EXAMPLE',
  bearer: 'abcdefghijklmnopqrstuvwxyz0123456789',
  cookie: 's3cr3tSessionValue0123',
  'daytona-key': '0a'.repeat(32),
  'github-token': 'abcdefghijklmnopqrstuvwxyz0123456789',
  jwt: 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'password-hash': 'RdescudvJCsgt3ub',
  pem: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
  'provider-key': 'abcdefghijklmnopqrstuvwxyz',
  'query-credential': 'abcdef0123456789abcdef',
  'slack-token': '1234567890-abcdefghijkl',
  'url-credential': 'hunter2hunter2',
  'resend-key': '4kQz9Xw2Lm7Pv3Rt8Ny5Bc1D',
  'supabase-key': 'Hq7Lw2Mz9Kx4Pt6Rv1Nb8C',
  'netlify-token': 'Q7mZ2xK9pW4rT8vN3bL6cY1dF5',
  'neon-key': 'k3m9x2q7w4p8r1t6v5n0b3l7c2',
  'local-agent-token': 'Zx8Qm2Lw7Rt4Kp9Vn3Bc6Yd1Fg5Hj0Ss2Aa4Ee6Ii8O',
  'local-agent-pairing-code': 'BCDF-GHJK',
};

/**
 * Spec 027 US4 (T073, FR-013): what `deployments.log_tail` stores — the last 64 KiB of the
 * combined install and build output, cut on a UTF-8 boundary, with every known secret shape
 * scrubbed through `scrubSecrets` before the cut.
 */
describe('logTail', () => {
  it('keeps a short log as it is', () => {
    expect(logTail('$ npm ci\nadded 212 packages\n')).toBe('$ npm ci\nadded 212 packages\n');
    expect(logTail('')).toBe('');
  });

  it('keeps exactly the last 64 KiB of a longer log', () => {
    const head = 'q'.repeat(10_000);
    const body = `${'x'.repeat(LOG_TAIL_MAX_BYTES - 20)}\nthe last line here\n`;
    const log = head + body;

    const tail = logTail(log);

    expect(bytes(tail)).toBe(LOG_TAIL_MAX_BYTES);
    expect(log.endsWith(tail)).toBe(true);
    expect(tail).not.toContain('q');
  });

  it.each([
    ['2-byte', 'é'],
    ['3-byte', '€'],
    ['4-byte', '🦊'],
  ])('cuts on a UTF-8 boundary through %s characters', (_label, char) => {
    // One ASCII byte in front shifts every character off the cut, whatever its width.
    const log = `a${char.repeat(Math.ceil((LOG_TAIL_MAX_BYTES * 2) / bytes(char)))}`;

    const tail = logTail(log);

    expect(tail).not.toContain('�');
    expect(bytes(tail)).toBeLessThanOrEqual(LOG_TAIL_MAX_BYTES);
    expect(bytes(tail)).toBeGreaterThan(LOG_TAIL_MAX_BYTES - bytes(char));
    expect(log.endsWith(tail)).toBe(true);
  });

  it('covers every rule in SECRET_SHAPES', () => {
    expect(new Set(Object.keys(SAMPLES))).toEqual(new Set(SECRET_SHAPES.map((s) => s.name)));
  });

  it.each(Object.entries(SAMPLES))('scrubs a %s before storage', (name, sample) => {
    const tail = logTail(`npm ERR! while fetching\n${sample}\nnpm ERR! exit 1\n`);

    expect(tail).not.toContain(SECRET_PART[name]);
    expect(tail).toContain(`[Redacted:${name}]`);
    expect(tail).toContain('npm ERR! exit 1');
  });

  it('scrubs before it cuts, so a secret across the cut leaves no fragment', () => {
    const secret = SAMPLES['github-token']!;
    // The raw cut would land 8 bytes into the token, keeping 32 of its characters.
    const log = `${'x'.repeat(99)}\n${secret}\n${'y'.repeat(LOG_TAIL_MAX_BYTES - secret.length + 7)}`;

    const tail = logTail(log);

    expect(tail).not.toMatch(/[a-z0-9]{12}\ny/);
    expect(bytes(tail)).toBeLessThanOrEqual(LOG_TAIL_MAX_BYTES);
  });

  it('is stable: a stored tail passed through again is unchanged', () => {
    const log = `${'z'.repeat(LOG_TAIL_MAX_BYTES)}\n${SAMPLES['provider-key']!}\n`;

    expect(logTail(logTail(log))).toBe(logTail(log));
  });
});

describe('LogBuffer', () => {
  it('keeps the combined output of every step, in order', () => {
    const buffer = new LogBuffer();
    buffer.note('$ npm ci');
    buffer.append('added 212 packages');
    buffer.note('$ npm run build');
    buffer.append('');
    buffer.append('vite v5 building for production...\n');

    expect(buffer.text()).toBe(
      '$ npm ci\nadded 212 packages\n$ npm run build\nvite v5 building for production...\n',
    );
  });

  it('gives what logTail gives for the whole output, however long, even across a secret', () => {
    const buffer = new LogBuffer();
    const whole: string[] = [];
    const add = (chunk: string): void => {
      buffer.append(chunk);
      whole.push(chunk.endsWith('\n') ? chunk : `${chunk}\n`);
    };

    for (let i = 0; i < 40; i++) add(`${String(i)} ${'n'.repeat(4_000)}`);
    add(SAMPLES.pem!);
    for (let i = 0; i < 16; i++) add(`tail ${String(i)} ${'€'.repeat(1_000)}`);

    expect(buffer.text()).toBe(logTail(whole.join('')));
    expect(buffer.text()).not.toContain(SECRET_PART.pem);
  });

  it('keeps the output a scrub pulls back into the tail once a secret shrinks', () => {
    const buffer = new LogBuffer();
    buffer.append('a'.repeat(1_000));
    buffer.append(SAMPLES.pem!);
    buffer.append('b'.repeat(LOG_TAIL_MAX_BYTES - 50));

    const tail = buffer.text();

    expect(tail).toContain('a');
    expect(bytes(tail)).toBe(LOG_TAIL_MAX_BYTES);
  });
});
