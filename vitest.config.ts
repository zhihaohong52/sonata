import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    // The default 'threads' pool has a documented class of bug where a worker
    // spins at 100% CPU during teardown instead of exiting — never reproduced
    // locally on macOS, but reliably hung every CI run on Linux after all 772
    // tests had already passed (confirmed via `ps aux`: one worker pinned at
    // 99.7% CPU with 5+ minutes of CPU time, not an idle leaked handle).
    // 'forks' is the pool vitest's own docs recommend for hang/segfault
    // stability. See https://github.com/vitest-dev/vitest/issues/8484.
    pool: 'forks',
  },
});
