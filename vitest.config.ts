import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    // A private tmux server for every test that creates a session; see the file.
    globalSetup: ['tests/global-setup.ts'],
  },
});
