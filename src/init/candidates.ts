/**
 * Native candidate minting for `sonata init` — the three operations that
 * turn user-supplied model picks into full `NativeCandidate` rows:
 *
 * - `addByokCandidates` — models a user named directly (typed in or picked
 *   from a gateway's `/models` response) that no harness listed
 * - `addLiveCandidates` — models a gateway's own `/models` endpoint
 *   returned but the harness catalogue did not
 * - `rewriteOauthToApiKey` — gateways that were originally OAuth (LiteLLM
 *   sets the base URL) but now have a BYOK key, so they need to be
 *   rewritten to the well-known api-key base URL
 *
 * The wizard, the `--yes` path, and `plan()` all need the same three
 * operations applied in the same order against the same `nativeByKey` map.
 * Three separate copies drifted: the original threw on an OAuth→api-key
 * rewrite whose gateway was not in `WELL_KNOWN_PROVIDER_URLS`, and `plan`
 * silently skipped instead. The silent skip kept the OAuth base URL on a
 * candidate whose auth had just been flipped to `api-key`, so the config
 * got a route that authenticates and then 401s. Single source lives here.
 */
import { isOauthGatewayAuth } from '../config.js';
import { WELL_KNOWN_PROVIDER_URLS } from '../detect.js';
import { byokCandidateKey } from '../native/models.js';
import type { NativeCandidate } from '../commands/init.js';
import type { InitEnvironment } from './discover.js';

/**
 * Candidates for models a user named directly.
 *
 * These must join `nativeByKey` before `nativeKeys` is resolved through it,
 * or every BYOK key looks up `undefined` and is filtered out silently — a
 * wizard that appears to work and writes an empty config.
 *
 * The base URL falls back to `WELL_KNOWN_PROVIDER_URLS[gateway]` when the
 * caller didn't already supply one for that gateway. The front ends
 * (wizard, `--yes`) build `byokUrls` from `env.byokProviders`, which IS the
 * well-known set, so the fallback never fires there. `plan()` builds
 * `byokUrls` from `env.providerBaseUrls` (a live-detected subset), so the
 * fallback is what keeps a `--providers byok/<x>` row with no live detect
 * working — and what keeps a saved-config re-init that goes through plan
 * (because the front end's map was unused) alive when the harness is gone
 * and nothing in `env.providerBaseUrls` mentions the saved gateway any
 * more. A gateway with no known URL — neither passed in nor well-known —
 * is silently skipped; the unknown-providers check upstream is what stops
 * truly-unknown gateways from reaching here.
 */
export function addByokCandidates(
  nativeByKey: Map<string, NativeCandidate>,
  byokUrls: ReadonlyMap<string, string>,
  byokModels: Record<string, string[]>,
  wireFormats: Record<string, 'anthropic'> = {},
): void {
  for (const [gateway, ids] of Object.entries(byokModels)) {
    const baseUrl = byokUrls.get(gateway) ?? WELL_KNOWN_PROVIDER_URLS[gateway];
    if (baseUrl === undefined) continue;
    const wireFormat = wireFormats[gateway];
    for (const id of ids) {
      const key = byokCandidateKey(gateway, id);
      nativeByKey.set(key, {
        key, gateway, id, contextWindow: 128000, baseUrl, auth: 'api-key',
        ...(wireFormat !== undefined ? { wireFormat } : {}),
      });
    }
  }
}

/**
 * Candidates for models only a gateway's own `/models` endpoint reported.
 *
 * The models step refreshes each gateway's list from the gateway itself, so
 * it can surface a model the harness catalogue never listed. Such a model has no
 * `NativeCandidate`, and `nativeKeys` is resolved through `nativeByKey` — so
 * without this it is selected, kept in the tiers, and then silently dropped
 * from `[models]`, producing a config that names a model it never defines.
 * An existing candidate always wins: the harness one carries a `harness`
 * route this cannot know about.
 */
export function addLiveCandidates(
  env: InitEnvironment,
  nativeByKey: Map<string, NativeCandidate>,
  liveModels: Record<string, string[]>,
): void {
  for (const [gateway, ids] of Object.entries(liveModels)) {
    const baseUrl = env.providerBaseUrls[gateway];
    if (baseUrl === undefined) continue;
    const auth = env.gatewayAuth.get(gateway) ?? 'api-key';
    // Only a key-authenticated gateway is ever refreshed, so this is a
    // guard rather than a case: an OAuth gateway's URL is LiteLLM's, and
    // writing it as an api-key entry would produce a route that 401s.
    if (isOauthGatewayAuth(auth)) continue;
    for (const id of ids) {
      const key = byokCandidateKey(gateway, id);
      if (nativeByKey.has(key)) continue;
      nativeByKey.set(key, { key, gateway, id, contextWindow: 128000, baseUrl, auth: 'api-key' });
    }
  }
}

/**
 * A gateway that was originally OAuth (from `env.gatewayAuth`) but now has a
 * BYOK key gets switched to api-key auth with the well-known base URL.
 *
 * THROWS — the OAuth→api-key transition MUST use a well-known provider URL,
 * not any URL from the original config (which would be the OAuth endpoint).
 * Silently skipping leaves a candidate with `auth: 'api-key'` but the
 * OAuth base URL, so the config gets a route that authenticates and 401s
 * later. The pre-refactor behaviour was to throw, and that is the
 * behaviour kept here: any caller without a well-known URL for the
 * gateway is in the wrong place. The message string is the contract
 * callers test against and must stay byte-identical.
 */
export function rewriteOauthToApiKey(
  nativeByKey: Map<string, NativeCandidate>,
  byokKeys: Record<string, string>,
): void {
  for (const gateway of Object.keys(byokKeys)) {
    for (const [key, candidate] of nativeByKey) {
      if (candidate.gateway !== gateway || candidate.auth === 'api-key') continue;
      if (!Object.hasOwn(WELL_KNOWN_PROVIDER_URLS, gateway)) {
        throw new Error(`sonata init: no API base URL is known for ${gateway}; cannot use an API key.`);
      }
      const baseUrl = WELL_KNOWN_PROVIDER_URLS[gateway];
      nativeByKey.set(key, { ...candidate, baseUrl, auth: 'api-key' });
    }
  }
}
