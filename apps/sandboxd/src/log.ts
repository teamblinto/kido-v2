const SENSITIVE = /key|token|secret|authorization/i;

export function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => !SENSITIVE.test(k)));
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, msg, ...safe })}\n`,
  );
}
