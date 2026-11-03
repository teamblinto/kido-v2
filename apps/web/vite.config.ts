import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    sourcemap: true,
    target: 'es2022',
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        changeOrigin: true,
        // Target the IPv4 loopback explicitly to match the API's 0.0.0.0 bind.
        // `localhost` resolves to ::1 first, and any unrelated process holding
        // [::1]:3000 (Docker Desktop and WSL port forwarding both do this) will
        // accept the connection and never answer, so the proxy returns 502 while
        // the API is perfectly healthy on IPv4.
        target: 'http://127.0.0.1:3000',
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    /*
     * Vitest's default is 5s, and these tests are slower than they look.
     *
     * `userEvent.type` dispatches a full keydown/keypress/input/keyup cycle per character and lets
     * React flush between each one, so filling two fields and submitting is hundreds of renders
     * before the first assertion. Alone that lands in well under a second; under `pnpm check`, which
     * runs this suite beside the API's integration tests against real Postgres and Redis, four
     * sign-in tests crossed 5s and failed while the components were behaving correctly.
     *
     * A timeout that fits the work rather than a faster test: the alternative is asserting on
     * `fireEvent.change`, which sets a value without ever proving the field is reachable by
     * keyboard. This repository has made this call once before — see the API's own suite timeout
     * and the load-fragile assertion T34 had to fix.
     */
    testTimeout: 20_000,
  },
});
