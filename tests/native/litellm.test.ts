import { describe, expect, it } from 'vitest';
import { envVarForGateway, litellmConfig } from '../../src/native/litellm.js';

describe('LiteLLM config', () => {
  it('emits one model_list entry per native model, keyed by env, never the key itself', () => {
    const cfg = litellmConfig({
      models: {
        'deepseek-v4-flash': {
          gateway: 'acme',
          id: 'deepseek-v4-flash-0731',
          contextWindow: 128000,
        },
      },
      gateways: { acme: { baseUrl: 'https://gateway.acme.example/v1' } },
      ports: { router: 4100, litellm: 4000 },
      generate: {},
    }, 'sk-master');
    const e = cfg.model_list[0];
    expect(e.model_name).toBe('deepseek-v4-flash');
    expect(e.litellm_params.model).toBe('openai/deepseek-v4-flash-0731');
    expect(e.litellm_params.api_base).toBe('https://gateway.acme.example/v1');
    expect(e.litellm_params.api_key).toBe('os.environ/SONATA_KEY_ACME');
    expect(cfg.general_settings.master_key).toBe('sk-master');
    expect(cfg.litellm_settings.drop_params).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain('sk-master-value');
  });

  it('maps a gateway name to an env var', () => {
    expect(envVarForGateway('acme')).toBe('SONATA_KEY_ACME');
    expect(envVarForGateway('open-router')).toBe('SONATA_KEY_OPEN_ROUTER');
  });
});
