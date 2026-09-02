import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // next/font/google only resolves inside Next's own build pipeline — stub it for tests.
      'next/font/google': path.resolve(__dirname, 'test/mocks/next-font-google.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'drizzle'],
  },
});
