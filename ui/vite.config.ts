import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/ui/',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    pool: 'forks',
    // Node 26 defines localStorage, sessionStorage and Storage itself, which would stand in front of jsdom's in the workers.
    poolOptions: { forks: { execArgv: ['--no-experimental-webstorage'] } },
  },
});
