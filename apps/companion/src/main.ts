/**
 * `baios-companion` (spec 040 § 7). Dials out to BAIOS and drives the person's own, signed-in CLI
 * on this machine; it never listens on the network and never reads a provider credential.
 */
import { fileURLToPath } from 'node:url';

import { runCli } from './cli.ts';
import { log } from './log.ts';

// Re-run as `mcp-approval` by Claude Code, so this file must stay the entry point.
const selfScript = fileURLToPath(import.meta.url);

runCli(process.argv.slice(2), selfScript).then(
  (code) => {
    process.exitCode = code;
    // Keep-alive sockets may hold the loop open after `start`; never past this point.
    setTimeout(() => process.exit(code), 500).unref();
  },
  (error: unknown) => {
    log.error(String(error));
    process.exitCode = 1;
  },
);
