import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: {
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 700,
    manifest: true,
    sourcemap: false,
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
  test: {
    coverage: {
      enabled: false,
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
