# Task 4 Report

## What changed

`proposeTiers` now expands each selected bare model key through `expandCandidates` before ranking. Models with Artificial Analysis effort-family rows therefore produce independent `@low`, `@high`, `@xhigh`, and `@max` candidates, each ranked using its own capability and cost. Catalog-less and family-less inputs remain identity expansions.

Avoidance now compares `splitCandidate(candidate).key`, so avoiding a bare model key demotes all of its effort variants together. Complex and simple admission, floor/ceiling leader selection, and complex fallback now operate on the expanded candidate list.

## Scoped references

Changed inside `proposeTiers`:

- `complex` filter: `modelKeys` -> `candidates`
- `preferred` filter: `modelKeys` -> `candidates`, with bare-key avoidance
- `leaders` fallback: `modelKeys` -> `candidates`
- `simple` filter: `modelKeys` -> `candidates`
- `complexFinal` fallback: `modelKeys` -> `candidates`
- `avoidance` now checks bare keys via `bareKey`

Deliberately unchanged in `catalogCoverage`: its parameter, iteration, and `scoreFor` calls continue to use the original bare `modelKeys`, because coverage reporting is about the configured model keys rather than proposed effort candidates.

## Tests

Added the three prescribed `proposeTiers - effort variants` tests to `tests/catalog.test.ts` without changing the shared `FAMILY_AA` fixture.

The required pre-implementation focused run failed as expected: the first complex candidates were bare `gpt-5.6-luna` and `gpt-5.6-terra`, while the test expected `@max` variants.

Commands run:

- `npm test -- tests/catalog.test.ts -t "effort variants"` - failed before implementation for the expected missing-expansion behavior.
- `npm test -- tests/catalog.test.ts` - passed: 65 tests.
- `npm run typecheck` - passed with no TypeScript errors.
- `git diff --check` - passed.

## Commit

Implementation commit: `4a658b9d88ecf3a86518a3ff826a45aa705f7984`.

## Concerns

No known concerns. The shell emitted an existing zsh completion warning (`compdef:153: _comps: assignment to invalid subscript range`) before npm commands; it did not affect test or typecheck results.
