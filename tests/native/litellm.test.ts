import { describe, expect, it } from 'vitest';
import { envVarForGateway, litellmConfig } from '../../src/native/litellm.js';
import { CODEX_OAUTH_BASE_URL, COPILOT_OAUTH_BASE_URL } from '../../src/config.js';

describe('LiteLLM config', () => {
  it('emits one model_list entry per native model, keyed by env, never the key itself', () => {
    const cfg = litellmConfig({
      models: {
        'deepseek-v4-flash': {
          gateway: 'vendorx',
          id: 'deepseek-v4-flash-0731',
          contextWindow: 128000,
        },
      },
      gateways: { vendorx: { baseUrl: 'https://bifrost.advai.net/v1', auth: 'api-key' } },
      ports: { router: 4100, litellm: 4000 },
      generate: {},
    }, 'sk-master');
    const e = cfg.model_list[0];
    expect(e.model_name).toBe('deepseek-v4-flash');
    expect(e.litellm_params.model).toBe('openai/deepseek-v4-flash-0731');
    expect(e.litellm_params.api_base).toBe('https://bifrost.advai.net/v1');
    expect(e.litellm_params.api_key).toBe('os.environ/SONATA_KEY_VENDORX');
    expect(cfg.general_settings.master_key).toBe('sk-master');
    expect(cfg.litellm_settings.drop_params).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain('sk-master-value');
  });

  it('maps a gateway name to an env var', () => {
    expect(envVarForGateway('vendorx')).toBe('SONATA_KEY_VENDORX');
    expect(envVarForGateway('open-router')).toBe('SONATA_KEY_OPEN_ROUTER');
  });
});

describe('LiteLLM config — codex-oauth gateways', () => {
  const codexConfig = () => litellmConfig({
    models: { 'gpt-5.6-luna': { gateway: 'codex', id: 'gpt-5.6-luna', contextWindow: 128000 } },
    gateways: { codex: { baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth' } },
    ports: { router: 4100, litellm: 4000 },
    generate: {},
  }, 'sk-master');

  it('routes through the chatgpt provider rather than openai', () => {
    const e = codexConfig().model_list[0];
    expect(e.litellm_params.model).toBe('chatgpt/gpt-5.6-luna');
  });

  it('sets mode: responses', () => {
    // Without it LiteLLM takes its chat-completions path and POSTs to the bare
    // backend-api/codex/ URL, which serves the ChatGPT web app — the reply is a
    // Cloudflare HTML challenge surfaced as an opaque ChatgptException.
    expect(codexConfig().model_list[0].model_info).toEqual({ mode: 'responses' });
  });

  it('passes neither api_base nor api_key, which would override the provider', () => {
    const e = codexConfig().model_list[0];
    expect(e.litellm_params).not.toHaveProperty('api_base');
    expect(e.litellm_params).not.toHaveProperty('api_key');
  });

  it('leaves api-key gateways in the same config untouched', () => {
    const cfg = litellmConfig({
      models: {
        'gpt-5.6-luna': { gateway: 'codex', id: 'gpt-5.6-luna', contextWindow: 128000 },
        'ds': { gateway: 'vendorx', id: 'deepseek-v4-flash-0731', contextWindow: 128000 },
      },
      gateways: {
        codex: { baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth' },
        vendorx: { baseUrl: 'https://bifrost.advai.net/v1', auth: 'api-key' },
      },
      ports: { router: 4100, litellm: 4000 },
      generate: {},
    }, 'sk-master');

    const byName = Object.fromEntries(cfg.model_list.map((m) => [m.model_name, m]));
    expect(byName['gpt-5.6-luna'].litellm_params.model).toBe('chatgpt/gpt-5.6-luna');
    expect(byName['ds'].litellm_params.model).toBe('openai/deepseek-v4-flash-0731');
    expect(byName['ds'].litellm_params.api_key).toBe('os.environ/SONATA_KEY_VENDORX');
    expect(byName['ds'].model_info).toBeUndefined();
  });
});

describe('LiteLLM config — copilot-oauth gateways', () => {
  const cfg = () => litellmConfig({
    models: { 'gpt4o-copilot': { gateway: 'copilot', id: 'gpt-4o', contextWindow: 128000 } },
    gateways: { copilot: { baseUrl: COPILOT_OAUTH_BASE_URL, auth: 'copilot-oauth' } },
    ports: { router: 4100, litellm: 4000 },
    generate: {},
  }, 'sk-master');

  it('routes through the github_copilot provider', () => {
    expect(cfg().model_list[0].litellm_params.model).toBe('github_copilot/gpt-4o');
  });

  it('passes neither api_base nor api_key', () => {
    const params = cfg().model_list[0].litellm_params;
    expect(params).not.toHaveProperty('api_base');
    expect(params).not.toHaveProperty('api_key');
  });

  it('sets no mode override — Copilot speaks chat-completions', () => {
    expect(cfg().model_list[0].model_info).toBeUndefined();
  });
});
