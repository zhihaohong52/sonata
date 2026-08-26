# Task 1 Report: SSE Usage Collector

## Implemented

- Added `src/native/usage.ts` with the pure Anthropic-shaped SSE usage collector from the brief.
- Added `tests/native/usage.test.ts` with the complete test cases from the brief.
- The collector merges `message_start` input/cache counts with the latest `message_delta` output count, tolerates split UTF-8 and JSON frames, ignores malformed data lines, bounds unterminated lines, and exposes non-streaming JSON parsing.

## Verification

Exact focused test command:

```text
npx vitest run tests/native/usage.test.ts
```

Output:

```text
 RUN  v2.1.9 /Users/zhihao.hong.52/Documents/workspace/sonata

 ✓ tests/native/usage.test.ts (11 tests) 4ms

 Test Files  1 passed (1)
      Tests  11 passed (1)
   Start at 01:43:53
   Duration 410ms (transform 40ms, setup 0ms, collect 36ms, tests 4ms, prepare 82ms)
```

The brief says 12 tests, but the supplied test file contains 11 tests (8 collector tests and 3 JSON-body tests); no test was added or removed.

Exact typecheck command:

```text
npm run typecheck
```

Output:

```text
> tsc --noEmit
```

`git diff --check` also passed.

## Changes Relative To Brief

None in implementation or tests. The report is the only additional file created because the task explicitly requires it.

## Concerns

The brief's expected count of 12 tests does not match the supplied complete test file's 11 tests. All supplied tests pass. No network calls, runtime dependencies, or I/O were introduced.
