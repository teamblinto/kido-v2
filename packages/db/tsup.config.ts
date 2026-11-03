import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  clean: !options.watch,
  dts: true,
  entry: ['src/index.ts', 'src/seed.ts'],
  format: ['esm', 'cjs'],
  sourcemap: true,
  splitting: false,
  treeshake: true,
}));
