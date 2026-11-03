import { defineConfig } from 'tsup';

// One self-contained ESM file with no node_modules beside it: it is the bin, and the hosted runner
// (spec 041), which BAIOS uploads alone as `/opt/baios/runner.js`. So `@repo/contracts` (private,
// never published) and zod are bundled in.
export default defineConfig({
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  entry: ['src/main.ts'],
  format: ['esm'],
  noExternal: ['@repo/contracts', 'zod'],
  platform: 'node',
  sourcemap: true,
  target: 'node24',
});
