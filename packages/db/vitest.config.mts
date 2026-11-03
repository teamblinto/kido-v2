import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // The default reporter hides stderr for a file whose tests all skipped, which is exactly the
    // case where the reason for skipping needs to be read.
    reporters: ['verbose'],
    restoreMocks: true,
  },
});
