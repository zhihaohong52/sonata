import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    // DIAGNOSTIC ONLY — not for main. A worker process spins at ~100% CPU
    // after all test files finish reporting, on both 'threads' and 'forks'
    // pools, only in CI (Linux). --prof writes a v8 profiler log so the spin
    // can be inspected with `node --prof-process` even if the process is
    // later killed by the job timeout.
    poolOptions: {
      forks: { execArgv: ['--prof'] },
      threads: { execArgv: ['--prof'] },
    },
  },
});
