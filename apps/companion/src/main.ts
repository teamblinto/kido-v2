/**
 * The BAIOS runner (spec 041): BAIOS uploads this bundle into a person's cloud agent home and runs
 * `start --hosted`. It dials out to BAIOS and drives the signed-in Claude Code CLI there; it never
 * listens on the network.
 */
import { fileURLToPath } from 'node:url';

import { runCli } from './cli.ts';
import { log } from './log.ts';

// Re-run as `mcp-tools` by Claude Code, so this file must stay the entry point.
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
