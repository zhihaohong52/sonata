import { execFileSync } from 'node:child_process';

import type { NativeConfig } from '../config.js';

export interface LiteLLMModelConfig {
  model_name: string;
  litellm_params: Record<string, unknown>;
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
  const modelList = Object.entries(native.models).map(([modelName, model]) => ({
    model_name: modelName,
    litellm_params: {
      model: `openai/${model.id}`,
      api_base: native.gateways[model.gateway].baseUrl,
      api_key: `os.environ/${envVarForGateway(model.gateway)}`,
    },
  }));

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
