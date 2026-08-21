/**
 * Model discovery for BYOK — bringing a provider and a key, with no harness.
 *
 * Every harness path learns its models from a catalogue sonata can read locally
 * (`opencode models`, `pi --list-models`, `reasonix doctor --json`). A provider
 * the user names directly has no such catalogue, so the only place to ask is the
 * provider itself: `GET <base>/models`, the OpenAI-compatible convention that
 * every gateway in `WELL_KNOWN_PROVIDER_URLS` follows.
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
  try {
    const response = await doFetch(modelsUrl(baseUrl), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { outcome: 'unauthorized', status: response.status };
    }
    if (!response.ok) return { outcome: 'unreadable' };

    const payload = await response.json() as unknown;
    const data = (payload as { data?: unknown })?.data;
    if (!Array.isArray(data)) return { outcome: 'unreadable' };

    const seen = new Set<string>();
    const models: FetchedModel[] = [];
    for (const entry of data) {
      if (entry === null || typeof entry !== 'object') continue;
      const { id, name } = entry as { id?: unknown; name?: unknown };
      if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) continue;
      seen.add(id);
      models.push(typeof name === 'string' && name.trim() !== '' ? { id, name } : { id });
    }
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
