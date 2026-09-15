# Task 1 Report: The UI Request Dispatcher

Status: DONE

## Implementation

- Added `src/native/ui.ts` with the exact `UI_PREFIX`, `UiDeps`, `jsonResponse`, and `handleUiRequest` interfaces.
- Added loopback Host validation, GET/HEAD-only handling, JSON error envelopes, no CORS headers, and the `api/ping`/`api/boom` stub routes.
- Mounted the dispatcher in `createRouterServer` only when `RouterDeps.ui` is provided, after the existing `/__sonata_health` route and before proxy routing.
- Added focused dispatcher coverage and a router regression proving `/v1/messages` still reaches the Anthropic proxy when the UI is mounted.

## Verification

- `npm run typecheck` — passed.
- `npx vitest run tests/native/ui.test.ts tests/native/router.test.ts` — 120 tests passed.
- `npx vitest run tests/native/` — 314 tests passed.
- `git diff --check` — passed.

## Commit

- `365f76e6c4f27ad95103cdfbbd95b37d4fa2882b`

## Concerns

- None.

## Review Fixes

- Rejected `HEAD` under `/__sonata/`; the dispatcher now accepts only `GET` and includes regression coverage.
- Made the loopback Host check validate the complete authority against `UiDeps.port`, accepting only the three port-qualified loopback forms, plus bare forms on port 80; added malformed and bare-host coverage.
- Replaced the ineffective `routeRequest` regression with an ephemeral-port `createRouterServer` integration test. It verifies that `POST /v1/messages` reaches the injected Anthropic fetch and that `POST /__sonata/api/usage` returns 405 without invoking it. The server is closed in `finally`.

## Review-Fix Verification

- `npm run typecheck` — passed (`tsc --noEmit`).
- `npx vitest run tests/native/ui.test.ts` — passed (12 tests).
- `npx vitest run tests/native/router.test.ts` — passed (111 tests).
