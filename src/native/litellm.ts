import { execFileSync } from 'node:child_process';

import { envVarForGateway } from './gateway-env.js';
import { providerForBaseUrl, requiresSessionHeader } from './providers.js';
import type { NativeConfig, UnifiedModelConfig, SonataConfig } from '../config.js';

export interface LiteLLMModelConfig {
  model_name: string;
  litellm_params: Record<string, unknown>;
  /**
   * Present only for codex-oauth. Without `mode: responses` LiteLLM takes its
   * chat-completions path and POSTs to the bare `backend-api/codex/` URL, which
   * serves the ChatGPT *web app* — the reply is a Cloudflare HTML challenge
   * surfaced as an opaque ChatgptException.
   *
   * `supports_system_message: false` is the second half of that pairing — see
   * the entry builder for why the Codex backend needs it.
   */
  model_info?: { mode: string; supports_system_message?: boolean };
}

export interface LiteLLMConfig {
  model_list: LiteLLMModelConfig[];
  litellm_settings: {
    drop_params: true;
    use_chat_completions_url_for_anthropic_messages: true;
    /**
     * The model groups LiteLLM forwards the client's `x-*` headers to. Absent
     * when none need it: forwarding hands the upstream every `x-*` header
     * Claude Code sent, so it is scoped to the endpoints that refuse a
     * request without a session header rather than switched on globally.
     */
    model_group_settings?: { forward_client_headers_to_llm_api: string[] };
  };
  general_settings: { master_key: string };
}

export { envVarForGateway } from './gateway-env.js';

function litellmModelEntry(
  modelName: string,
  gateway: string,
  id: string,
  gateways: NativeConfig['gateways'],
  api?: 'responses',
): LiteLLMModelConfig {
  // An OAuth gateway is served by one of LiteLLM's own providers, which
  // supplies the base URL, the bearer and any refresh or token exchange.
  // Passing api_base or api_key here would override that and break it.
  const auth = gateways[gateway].auth;
  if (auth === 'codex-oauth') {
    return {
      model_name: modelName,
      litellm_params: { model: `chatgpt/${id}` },
      model_info: {
        // Without this LiteLLM uses chat-completions and POSTs to the bare
        // backend-api/codex/ URL, which serves the ChatGPT web app.
        mode: 'responses',
        // The Codex backend answers any `role: system` message with
        // `{"detail":"System messages are not allowed"}` — a 400 naming
        // neither the field nor the shape. LiteLLM's chatgpt provider does not
        // normalize that itself: BerriAI/litellm#22968 reports it and its fix,
        // PR #22967, was closed without merging, so 1.98.0 still emits the
        // rejected role. Declaring the model as not supporting system messages
        // routes the prompt through `map_system_message_pt`, which folds it in
        // at LiteLLM's own layer rather than sonata rewriting the body.
        //
        // `flattenSystemBlocks` (src/native/router.ts) remains load-bearing:
        // that helper concatenates onto message content and raises
        // `can only concatenate list (not "str") to list` on Claude Code's
        // block arrays (BerriAI/litellm#32904). Flattening to a string first
        // is what keeps this off that crash path — the two fixes are a pair,
        // and neither is sufficient alone.
        supports_system_message: false,
      },
    };
  }
  if (auth === 'copilot-oauth') {
    // Copilot speaks chat-completions, so it needs no mode override; the
    // provider exchanges the GitHub token for a Copilot key itself.
    return {
      model_name: modelName,
      litellm_params: { model: `github_copilot/${id}` },
    };
  }
  // The gateway's declared provider, else the table, else `openai` as the
  // fallback for an endpoint nobody has classified. A blanket `openai/` reaches
  // a vendor's compatibility shim rather than its native API, and a shim is
  // where vendor-specific state has nowhere to live — losing Gemini's
  // `thought_signature` that way is what let one model absorb a whole tier.
  // `wireFormat` is honoured here, not only where `parseConfig` maps it: a
  // `NativeConfig` built in code (tests, and any future non-parse path) would
  // otherwise silently lose the dialect it declared and fall through to the
  // `openai` fallback — which is exactly the confident-wrong-dialect failure
  // this table exists to prevent.
  const provider = gateways[gateway].provider
    ?? gateways[gateway].wireFormat
    ?? providerForBaseUrl(gateway);
  // `responses/` is LiteLLM's own per-model switch onto its Responses bridge,
  // and it holds under `use_chat_completions_url_for_anthropic_messages`, which
  // only decides the default. Measured 2026-10-09 on vendorz (vendorz):
  // `gpt-6.1-sol` and `gpt-6-astra` answer every chat-completions request that
  // carries tools and `reasoning_effort` with a 400 naming `/v1/responses`,
  // and serve multi-turn tool use at `xhigh` through this prefix.
  return {
    model_name: modelName,
    litellm_params: {
      model: `${provider}/${api === 'responses' ? 'responses/' : ''}${id}`,
      api_base: gateways[gateway].baseUrl,
      api_key: `os.environ/${envVarForGateway(gateway)}`,
    },
  };
}

/**
 * The settings every generated config carries, defined once.
 *
 * `use_chat_completions_url_for_anthropic_messages` is the load-bearing one
 * (see the comment on it below), and a third hand-inlined copy is a third place
 * it can silently stop matching.
 */
function sharedSettings(masterKey: string, forwardHeaders: string[] = []): Pick<LiteLLMConfig, 'litellm_settings' | 'general_settings'> {
  const settings = {
    // LiteLLM 1.82+ silently routes any `openai/<id>` model hit through its
    // Anthropic /v1/messages passthrough to the OpenAI Responses API rather
    // than chat/completions (see _should_route_to_responses_api in
    // llms/anthropic/experimental_pass_through/messages/handler.py). Every
    // api-key gateway sonata generates uses `openai/<id>`, and not every
    // OpenAI-compatible backend implements the Responses API — acme's own
    // proxy rejects the `output_text` content-block type Responses mode uses
    // to replay a prior assistant turn, breaking any multi-turn conversation.
    // This flag is LiteLLM's own documented opt-out.
    litellm_settings: { drop_params: true, use_chat_completions_url_for_anthropic_messages: true },
    general_settings: { master_key: masterKey },
  } as Pick<LiteLLMConfig, 'litellm_settings' | 'general_settings'>;
  if (forwardHeaders.length > 0) {
    settings.litellm_settings.model_group_settings = { forward_client_headers_to_llm_api: forwardHeaders };
  }
  return settings;
}

export function litellmConfig(
  native: NativeConfig,
  masterKey: string,
  unifiedModels: Record<string, UnifiedModelConfig> = {},
): LiteLLMConfig {
  const modelList = Object.entries(native.models).map(
    ([modelName, model]) => litellmModelEntry(modelName, model.gateway, model.id, native.gateways, model.api),
  );
  const forwardHeaders = Object.entries(native.models)
    .filter(([, model]) => requiresSessionHeader(native.gateways[model.gateway]?.baseUrl))
    .map(([modelName]) => modelName);

  // Legacy native.models entries stay authoritative during migration: a
  // unified [models] entry sharing a key with one is skipped rather than
  // emitting a duplicate model_name LiteLLM would then pick between.
  for (const [modelName, model] of Object.entries(unifiedModels)) {
    if (modelName in native.models) continue;
    if (model.gateway === undefined || model.id === undefined) continue;
    modelList.push(litellmModelEntry(modelName, model.gateway, model.id, native.gateways, model.api));
    if (requiresSessionHeader(native.gateways[model.gateway]?.baseUrl)) forwardHeaders.push(modelName);
  }

  return { model_list: modelList, ...sharedSettings(masterKey, forwardHeaders) };
}

/**
 * The union of every known tenant's native models, each under
 * `<tenantId>/<key>`. One LiteLLM child serves every project; the namespace is
 * what lets two projects both call a model `flash` and mean different things.
 * Credentials are deliberately not namespaced: the key store is machine-wide
 * by gateway name, so two tenants naming `acme` already share one key, while
 * `api_base` is per entry so they still each reach their own endpoint.
 */
export function litellmConfigForTenants(
  tenants: { id: string; config: SonataConfig }[],
  masterKey: string,
): LiteLLMConfig {
  const modelList: LiteLLMModelConfig[] = [];
  const forwardHeaders: string[] = [];
  for (const { id, config } of tenants) {
    const native = config.native;
    if (native === undefined) continue;
    const single = litellmConfig(native, masterKey, config.unifiedModels);
    for (const entry of single.model_list) {
      modelList.push({ ...entry, model_name: `${id}/${entry.model_name}` });
    }
    for (const name of single.litellm_settings.model_group_settings?.forward_client_headers_to_llm_api ?? []) {
      forwardHeaders.push(`${id}/${name}`);
    }
  }
  return { model_list: modelList, ...sharedSettings(masterKey, forwardHeaders) };
}

export function litellmConfigYamlForTenants(
  tenants: { id: string; config: SonataConfig }[],
  masterKey: string,
): string {
  return `${JSON.stringify(litellmConfigForTenants(tenants, masterKey), null, 2)}\n`;
}

/** LiteLLM accepts JSON config files, so keep serialization dependency-free and stable. */
export function litellmConfigYaml(
  native: NativeConfig,
  masterKey: string,
  unifiedModels: Record<string, UnifiedModelConfig> = {},
): string {
  return `${JSON.stringify(litellmConfig(native, masterKey, unifiedModels), null, 2)}\n`;
}

export function findLitellm(): string | null {
  try {
    return execFileSync('which', ['litellm'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
