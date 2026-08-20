import { execFileSync } from 'node:child_process';

import type { NativeConfig } from '../config.js';

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
  litellm_settings: { drop_params: true };
  general_settings: { master_key: string };
}

export function envVarForGateway(gateway: string): string {
  return `SONATA_KEY_${gateway.toUpperCase().replace(/-/g, '_')}`;
}

export function litellmConfig(native: NativeConfig, masterKey: string): LiteLLMConfig {
  const modelList = Object.entries(native.models).map(([modelName, model]): LiteLLMModelConfig => {
    // A codex-oauth gateway is served by LiteLLM's own `chatgpt` provider, which
    // supplies the base URL, the bearer, the account header and token refresh.
    // Passing api_base or api_key here would override that and break it.
    if (native.gateways[model.gateway].auth === 'codex-oauth') {
      return {
        model_name: modelName,
        litellm_params: { model: `chatgpt/${model.id}` },
        model_info: { mode: 'responses' },
      };
    }
    return {
      model_name: modelName,
      litellm_params: {
        model: `openai/${model.id}`,
        api_base: native.gateways[model.gateway].baseUrl,
        api_key: `os.environ/${envVarForGateway(model.gateway)}`,
      },
    };
  });

  return {
    model_list: modelList,
    litellm_settings: { drop_params: true },
    general_settings: { master_key: masterKey },
  };
}

/** LiteLLM accepts JSON config files, so keep serialization dependency-free and stable. */
export function litellmConfigYaml(native: NativeConfig, masterKey: string): string {
  return `${JSON.stringify(litellmConfig(native, masterKey), null, 2)}\n`;
}

export function findLitellm(): string | null {
  try {
    return execFileSync('which', ['litellm'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
