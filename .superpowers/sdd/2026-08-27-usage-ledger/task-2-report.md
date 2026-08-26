# Task 2 Report: Ledger Store

## Implemented

- Added `src/ledger.ts` with the append-only daily JSONL usage ledger.
- Added the `LedgerPrice` and `LedgerRow` interfaces, consuming `UsageTokens` through a type-only import from `./native/usage.js`.
- Added UTC-based ledger path helpers, row appending, corrupt-line-tolerant reads with timestamp filtering, and retention pruning that only removes matching day files.
- Added `tests/ledger.test.ts` covering UTC paths, round trips, line appends, corrupt lines, cross-day filtering, missing ledgers, retention pruning, unrelated files, and missing directories.

## Verification

- `npx vitest run tests/ledger.test.ts`
  - PASS: 9 tests in 1 file.
- `npm run typecheck`
  - PASS: `tsc --noEmit`.
- `npm test`
  - PASS: 55 test files, 1061 tests.
  - Vitest exit code: 0.
- `git diff --check`
  - PASS: no whitespace errors.

## Changes Relative To Brief

None. The test and implementation were transcribed from the brief without redesign or additional runtime dependencies.

## Concerns

None.

## Round 1 Fix Report

Addressed all four review findings and the ruled type change:

- `readRows` now rejects null/non-object lines and lines without a string timestamp before accessing row fields; added a literal `null` regression test.
- Retention cutoff is floored to UTC midnight, preserving the midday boundary day; the pruning test now pins and checks that boundary file.
- The UTC path test temporarily sets `TZ=Pacific/Kiritimati` and restores the prior value.
- Renamed the append test to describe its actual assertion and verifies both line count and JSON parseability; documented reliance on `O_APPEND` in `appendRow`.
- Changed `LedgerPrice` to a discriminated union so `source: 'none'` cannot carry `totalUsd`.

Verification:

- `npx vitest run tests/ledger.test.ts`: PASS, 10 tests.
- `npm run typecheck`: PASS, `tsc --noEmit`.
- `npm test`: PASS, 55 test files, 1061 tests.

No other departures from the ruling or brief.
