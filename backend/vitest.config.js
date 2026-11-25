import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    fileParallelism: false,
    testTimeout: 90000,
    hookTimeout: 60000,
    clearMocks: true,
    restoreMocks: true
  }
});
