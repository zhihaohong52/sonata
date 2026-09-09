# Task 3 Report

## Status
DONE

## Requirements
- Added optional `LedgerRow.project` attribution for newly recorded router rows while preserving legacy rows.
- Added optional project filtering to `spentTodayUsd`; calls without a project continue to include all rows.
- Changed `BudgetStatus` to carry the originating `configPath`.
- Changed `budgetRefusal` to accept ordered statuses and refuse on the first reached cap, naming its config file.
- Updated usage project grouping to prefer explicit row attribution and fall back to the session map.
- Temporarily wrapped the router's existing single budget status in an array, as required for Task 3.
- Propagated the request project header through tier, direct LiteLLM, direct Anthropic, failure, exhausted-tier, streaming, and non-streaming recording paths.

## Test-First Evidence
The focused RED run failed in the expected places before implementation: project-filtered spend returned the unfiltered total, the old single-status budget refusal could not iterate the new array shape, cap naming assertions failed, and usage grouping returned `unknown` instead of the row project.

## Verification
- `npx vitest run tests/budget.test.ts tests/commands/usage.test.ts tests/native/router.test.ts` — PASS, 98 tests.
- `npm run typecheck` — PASS.
- `git diff --check` — PASS.

## Self-Review
Reviewed the complete scoped diff. Changes are limited to the requested ledger, budget, usage, serve wiring, router attribution seam, and focused tests. Existing legacy ledger rows remain valid because `project` is optional. Spend filtering uses exact project equality only when a project is supplied, and retains the existing priced-only semantics.

## Commit
`61c3dd8 feat(ledger,budget): project on every row; caps per file`

No push performed.

## Review Fixes

Coordinator review identified that the temporary Task 3 wiring had incorrectly narrowed machine-wide spend to `opts.cwd`, and had prematurely threaded an untrusted project header into ledger contexts. The fix restores `spentTodayUsd(opts.home)` for the machine cap, retains `configPath`, strips `x-sonata-project` in `requestHeaders` on every upstream path, and removes all Task 3 router project threading so Task 4 can resolve tenancy centrally.

## Review Verification
- `npx vitest run tests/budget.test.ts tests/commands/usage.test.ts tests/native/router.test.ts tests/commands/serve.test.ts` — PASS, 179 tests.
- `npx vitest run tests/commands/serve.test.ts -t budget` — covered by the full `serve.test.ts` run above and passes.
- `npm run typecheck` — PASS.

## Review Fix Commit
Pending creation as a new commit with the requested message and trailer.
