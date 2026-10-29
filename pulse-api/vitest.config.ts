import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 15_000,
    include: ['tests/**/*.test.ts'],
    // Integration tests hit a live server — run sequentially
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
