# Task 2 Report: Auto-route Core

## Implemented

- Added `AutoRouteRecord`, `LedgerRow.route`, and `LedgerRow.autoRoute` to `src/ledger.ts`.
- Added `src/native/auto-route.ts` with:
  - `sonata-<role>-auto` alias parsing.
  - Safe extraction and cleaning of the first user task, including reminder removal and the 8,000-character cap.
  - Fallback tier selection.
  - TypeSafe Jev Choice request construction and response validation.
  - Bearer-authenticated Jev classifier calls with per-attempt timeout and retry.
  - Fail-open tier policy with confidence and offered-tier validation, deadline cancellation, and sanitized failure reasons.
  - Bounded TTL/LRU-style decision storage with shared in-flight decisions and rejected-creation cleanup.
- Added the specified focused test suite in `tests/native/auto-route.test.ts` (23 tests).

## TDD Evidence

RED:

```text
npx vitest run tests/native/auto-route.test.ts
FAIL ... Cannot find module '../../src/native/auto-route.js'
```

GREEN:

```text
npx vitest run tests/native/auto-route.test.ts
Test Files 1 passed (1)
Tests 23 passed (23)
```

Additional verification:

```text
npm run typecheck
passed (application and test typechecks)

npm test
Test Files 153 passed (153)
Tests 3230 passed (3230)
```

## Files Changed

- `src/native/auto-route.ts`
- `src/ledger.ts`
- `tests/native/auto-route.test.ts`

## Deviations From Brief

- The brief's requested `Tier` import from `src/config.ts` was not possible because this checkout does not export `Tier` there; `Tier` is exported from `src/commands/agents.ts`, so the implementation imports it from that module.
- No behavioral deviations from the brief were needed.
- The implementation follows the brief's supplied code and tests; formatting remains consistent with the existing repository's formatter configuration.

## Self-review Findings

- No blocking issues found during review.
- The module is intentionally not wired into the router, as required for Task 2; wiring is deferred to Task 3.

## Commit

`17c559d feat(auto-route): task cleaning, Jev Choice request, fail-open policy, decision store`

## Fix Round 1

- Hardened `parseJevAnswer` so confidence must be finite and within [0, 1], and probabilities must be a non-array object whose values are finite numbers within [0, 1].
- Added a `DecisionStore` generation counter so `clear()` invalidates in-flight creations and prevents their results from being inserted afterward.
- Added regression coverage for array/string/invalid probability values, NaN/Infinity/out-of-range confidence, and pending creation resurrection after clear.

Covering tests:

```text
npx vitest run tests/native/auto-route.test.ts
Test Files 1 passed (1)
Tests 25 passed (25)

npm run typecheck
passed (application and test typechecks)
```
