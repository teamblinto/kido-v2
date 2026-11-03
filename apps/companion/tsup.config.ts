import { defineConfig } from 'tsup';

// One self-contained ESM file with no node_modules beside it: the runner (spec 041), which BAIOS
// uploads alone as `/opt/baios/runner.mjs`. So `@repo/contracts` (private, never published) and
// zod are bundled in.
export default defineConfig({
  clean: true,
  entry: ['src/main.ts'],
  format: ['esm'],
  noExternal: ['@repo/contracts', 'zod'],
  platform: 'node',
  sourcemap: true,
  target: 'node24',
});
