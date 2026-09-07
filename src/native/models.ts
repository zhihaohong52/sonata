/**
 * Model discovery for BYOK — bringing a provider and a key, with no harness.
 *
 * Every harness path learns its models from a catalogue sonata can read locally
 * (`opencode models`, `pi --list-models`, `reasonix doctor --json`). A provider
 * the user names directly has no such catalogue, so the only place to ask is the
 * provider itself: `GET <base>/models`, the OpenAI-compatible convention that
 * every gateway in `WELL_KNOWN_PROVIDER_URLS` follows — except Google, whose
 * entry points at the *native* Generative Language API (needed so LiteLLM's
 * `gemini/` provider can reach it for real inference — see
 * `PROVIDER_FOR_GATEWAY` in `native/providers.ts`), not its separate
 * `v1beta/openai` compatibility shim. That endpoint takes a key via
 * `x-goog-api-key`, not `Authorization: Bearer` — an API key is not an OAuth
 * token, so Google answers Bearer auth with a flat 401 regardless of whether
 * the key is valid — and lists models as `{ models: [{ name: "models/<id>",
 * ... }] }`, not `{ data: [{ id }] }`. `isGoogleGenerativeLanguage` detects the
 * host and switches both the header and the parse.
 *
 * It is a convention, not a guarantee. A provider may not implement it, may
 * shape the payload differently, or may simply be unreachable — so `fetchModels`
 * **never throws and never distinguishes those cases**: they all return `[]`, and
 * the caller falls back to letting the user type ids. Reporting them separately
 * would imply a difference the caller cannot act on.
 */
import { WELL_KNOWN_PROVIDER_URLS } from '../detect.js';

export interface FetchedModel {
  id: string;
  name?: string;
}

/**
 * Why a catalogue could not be read — but only to the resolution the caller can
 * act on.
 *
 * `unauthorized` is the one that earns its own case: it means the key is wrong,
 * and the user's next move is to type a different one. Everything else —
 * no such endpoint, rate limited, HTML instead of JSON, a payload with no
 * `data` array — leads to the same place, typing model ids by hand, so
 * splitting them further would be a distinction without a difference.
 *
 * Only 401 and 403 map to `unauthorized`. A 404 means the provider has no
 * `/models` endpoint, and re-prompting for a key there would misdiagnose in the
 * opposite direction from the bug this exists to fix.
 */
export type FetchModelsResult =
  | { outcome: 'ok'; models: FetchedModel[] }
  | { outcome: 'unauthorized'; status: number }
  | { outcome: 'unreachable' }
  | { outcome: 'unreadable' };

/** Where a provider's model list lives, given its base url. */
function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`;
}

/** Google's Generative Language API needs `x-goog-api-key` and a different list shape — see the module docstring. */
function isGoogleGenerativeLanguage(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

/** The OpenAI convention: `{ data: [{ id, name? }] }`. */
function parseOpenAiModels(payload: unknown): FetchedModel[] | undefined {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return undefined;

  const seen = new Set<string>();
  const models: FetchedModel[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) continue;
    seen.add(id);
    models.push(typeof name === 'string' && name.trim() !== '' ? { id, name } : { id });
  }
  return models;
}

/**
 * Google's native shape: `{ models: [{ name: "models/<id>", displayName?,
 * supportedGenerationMethods? }] }`. `supportedGenerationMethods` filters out
 * embedding/AQA-only entries when the field is present, but never excludes on
 * its absence — an unfamiliar response shape should fall through unfiltered
 * rather than be read as "supports nothing".
 */
function parseGoogleModels(payload: unknown): FetchedModel[] | undefined {
  const data = (payload as { models?: unknown })?.models;
  if (!Array.isArray(data)) return undefined;

  const seen = new Set<string>();
  const models: FetchedModel[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue;
    const { name, displayName, supportedGenerationMethods } =
      entry as { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown };
    if (typeof name !== 'string') continue;
    if (Array.isArray(supportedGenerationMethods) && !supportedGenerationMethods.includes('generateContent')) continue;
    const id = name.replace(/^models\//, '');
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    models.push(typeof displayName === 'string' && displayName.trim() !== '' ? { id, name: displayName } : { id });
  }
  return models;
}

/** Google answers a bad key with 400 INVALID_ARGUMENT, not 401/403 — named explicitly rather than folded into "unreadable". */
async function isGoogleKeyRejection(response: Response): Promise<boolean> {
  try {
    const body = await response.json() as { error?: { message?: unknown; status?: unknown } };
    const message = typeof body?.error?.message === 'string' ? body.error.message : '';
    return body?.error?.status === 'INVALID_ARGUMENT' && /api key not valid/i.test(message);
  } catch {
    return false;
  }
}

/**
 * The models a provider reports, or why it would not say.
 *
 * Timeout-bounded and non-throwing, matching `copilotTokenCanExchange`: an
 * offline machine gets an answer rather than a hang.
 */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<FetchModelsResult> {
  const doFetch = opts.fetch ?? fetch;
  const google = isGoogleGenerativeLanguage(baseUrl);
  try {
    const response = await doFetch(modelsUrl(baseUrl), {
      headers: google ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { outcome: 'unauthorized', status: response.status };
    }
    if (!response.ok) {
      if (google && response.status === 400 && await isGoogleKeyRejection(response)) {
        return { outcome: 'unauthorized', status: response.status };
      }
      return { outcome: 'unreadable' };
    }

    const payload = await response.json() as unknown;
    const models = google ? parseGoogleModels(payload) : parseOpenAiModels(payload);
    if (models === undefined) return { outcome: 'unreadable' };
    return { outcome: 'ok', models };
  } catch {
    // Refused, timed out, DNS failure, or a body that would not parse.
    return { outcome: 'unreachable' };
  }
}

/**
 * Providers a user can name without having any harness installed.
 *
 * Deduplicated **by url, keeping the first name**: the underlying map lists
 * `openai` before its `openai-codex` and `codex` aliases, so keep-first is what
 * makes the picker say `openai`.
 *
 * `anthropic` is excluded. Every model it serves is `claude-*`, a prefix the
 * router reserves for Anthropic and `parseConfig` refuses, so its catalogue
 * filters to nothing — offering a provider that can yield no usable model is
 * worse than not offering it.
 */
export function wellKnownProviders(): Array<{ name: string; url: string }> {
  const byUrl = new Map<string, string>();
  for (const [name, url] of Object.entries(WELL_KNOWN_PROVIDER_URLS)) {
    if (name === 'anthropic') continue;
    if (!byUrl.has(url)) byUrl.set(url, name);
  }
  return [...byUrl.entries()]
    .map(([url, name]) => ({ name, url }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The config key for a BYOK model.
 *
 * Shared by the wizard and `cmdInit` on purpose: the wizard puts this key into
 * `nativeKeys` and `cmdInit` looks the candidate up by it, so computing the
 * formula twice is how the two silently stop agreeing. Slashes are flattened to
 * dashes exactly as harness-discovered keys are.
 */
export function byokCandidateKey(gateway: string, id: string): string {
  return `${gateway}-${id}`.replace(/\//g, '-');
}
