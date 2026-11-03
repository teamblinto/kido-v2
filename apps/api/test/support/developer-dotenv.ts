import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The developer's `apps/api/.env`, for the suites that reach a real Daytona or model and say so.
 * `AppModule` ignores that file under test so a key in it cannot leak into a suite that boots
 * `RUN_PROFILES=api` (the schema refuses the pair); a suite that wants it imports this module
 * before `AppModule`. Same precedence as the defaults: what is already set wins.
 */
const file = resolve(process.cwd(), '.env');

if (existsSync(file)) {
  // ponytail: KEY=value lines only, no expansion or multi-line values; dotenv if .env grows them.
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);

    if (match) {
      process.env[match[1]!] ??= match[2]!.replace(/^(["'])(.*)\1$/, '$2');
    }
  }
}
