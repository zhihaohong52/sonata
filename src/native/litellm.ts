import { execFileSync } from 'node:child_process';

import { providerForBaseUrl } from './providers.js';
import type { NativeConfig, UnifiedModelConfig } from '../config.js';

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
  litellm_settings: { drop_params: true; use_chat_completions_url_for_anthropic_messages: true };
  general_settings: { master_key: string };
}

export function envVarForGateway(gateway: string): string {
  return `SONATA_KEY_${gateway.toUpperCase().replace(/-/g, '_')}`;
}

function litellmModelEntry(
  modelName: string,
  gateway: string,
  id: string,
  gateways: NativeConfig['gateways'],
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
  return {
    model_name: modelName,
    litellm_params: {
      model: `${provider}/${id}`,
      api_base: gateways[gateway].baseUrl,
      api_key: `os.environ/${envVarForGateway(gateway)}`,
    },
  };
}

export function litellmConfig(
  native: NativeConfig,
  masterKey: string,
  unifiedModels: Record<string, UnifiedModelConfig> = {},
): LiteLLMConfig {
  const modelList = Object.entries(native.models).map(
    ([modelName, model]) => litellmModelEntry(modelName, model.gateway, model.id, native.gateways),
  );

  // Legacy native.models entries stay authoritative during migration: a
  // unified [models] entry sharing a key with one is skipped rather than
  // emitting a duplicate model_name LiteLLM would then pick between.
  for (const [modelName, model] of Object.entries(unifiedModels)) {
    if (modelName in native.models) continue;
    if (model.gateway === undefined || model.id === undefined) continue;
    modelList.push(litellmModelEntry(modelName, model.gateway, model.id, native.gateways));
  }

  return {
    model_list: modelList,
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
  };
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
