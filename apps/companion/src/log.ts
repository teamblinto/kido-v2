/**
 * Concise leveled logging to stderr (stdout belongs to command output, and to the MCP channel in
 * `mcp-approval`). Every line is scrubbed, so a token that slips into a message never reaches a
 * terminal or a log file.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

const isLevel = (value: string | undefined): value is LogLevel =>
  value !== undefined && value in LEVELS;

const envLevel = process.env.BAIOS_COMPANION_LOG;
let threshold: number = LEVELS[isLevel(envLevel) ? envLevel : 'info'];

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

export function isDebug(): boolean {
  return threshold <= LEVELS.debug;
}

function write(level: LogLevel, message: string): void {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 19);
  process.stderr.write(`${time} ${level.padEnd(5)} ${scrub(message)}\n`);
}

export const log = {
  debug: (message: string) => write('debug', message),
  error: (message: string) => write('error', message),
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
};

/**
 * Only shapes that are unmistakably credentials, so agent output (code, prose, diffs) passes through
 * intact: private-key blocks, well-known key prefixes, JWTs and long bearer tokens.
 */
const TOKEN_PATTERNS: [RegExp, string][] = [
  [
    /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g,
    '[redacted private key]',
  ],
  [/\bbld_[A-Za-z0-9_-]{43}\b/g, 'bld_[redacted]'],
  [/\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, 'sk-[redacted]'],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, '[redacted]'],
  [/\b(?:gh[opsur]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g, '[redacted]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, 'Bearer [redacted]'],
];

/** Conservative: for agent output and approval details sent to BAIOS (H2), not just logs. */
export function scrubTokens(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TOKEN_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  ...TOKEN_PATTERNS,
  [/\bbld_[A-Za-z0-9_-]+/g, 'bld_[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]'],
  [/\b(?:gh[opsur]_|xox[abp]-)[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [/\b(Bearer|Basic)\s+[^\s"']+/gi, '$1 [redacted]'],
  [
    /((?:token|secret|password|passwd|api[_-]?key|authorization|device[_-]?code)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
    '$1[redacted]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // Long opaque runs (device codes, keys, hashes) are never worth showing.
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]'],
];

/** Removes anything that looks like a credential or an identifier from free text. */
export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
