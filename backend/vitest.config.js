import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    fileParallelism: false,
    testTimeout: 45000,
    hookTimeout: 45000,
    clearMocks: true,
    restoreMocks: true
  }
});
