import { execFileSync } from 'node:child_process';

import type { NativeConfig, UnifiedModelConfig } from '../config.js';

export interface LiteLLMModelConfig {
  model_name: string;
  litellm_params: Record<string, unknown>;
  /**
   * Present only for codex-oauth. Without `mode: responses` LiteLLM takes its
   * chat-completions path and POSTs to the bare `backend-api/codex/` URL, which
   * serves the ChatGPT *web app* — the reply is a Cloudflare HTML challenge
   * surfaced as an opaque ChatgptException.
   */
  model_info?: { mode: string };
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
      // Without this LiteLLM uses chat-completions and POSTs to the bare
      // backend-api/codex/ URL, which serves the ChatGPT web app.
      model_info: { mode: 'responses' },
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
  if (gateways[gateway].wireFormat === 'anthropic') {
    return {
      model_name: modelName,
      litellm_params: {
        model: `anthropic/${id}`,
        api_base: gateways[gateway].baseUrl,
        api_key: `os.environ/${envVarForGateway(gateway)}`,
      },
    };
  }
  return {
    model_name: modelName,
    litellm_params: {
      model: `openai/${id}`,
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
