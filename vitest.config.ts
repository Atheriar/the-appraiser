import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Tests must never hit the network or a real cookie; use docs/fixtures.
    testTimeout: 10_000,
  },
});
