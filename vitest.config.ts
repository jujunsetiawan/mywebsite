import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'spike/**', 'pipeline/**', 'tests/unit/fixtures/**', 'tests/e2e/**'],
    environment: 'node',
  },
  server: {
    watch: {
      ignored: ['**/spike/**', '**/pipeline/**'],
    },
  },
});
