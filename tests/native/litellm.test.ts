import { describe, expect, it } from 'vitest';
import { envVarForGateway, litellmConfig } from '../../src/native/litellm.js';
import { CODEX_OAUTH_BASE_URL, COPILOT_OAUTH_BASE_URL, type NativeConfig } from '../../src/config.js';

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
      gateways: { acme: { baseUrl: 'https://gateway.acme.example/v1', auth: 'api-key' } },
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

  it('opts every api-key gateway out of LiteLLM\'s Responses-API routing for /v1/messages', () => {
    // Not every openai-compatible backend implements the Responses API —
    // acme's own proxy 400s on it (rejects the `output_text` content
    // type Responses mode uses to replay a prior assistant turn). LiteLLM
    // silently opts `openai/<id>` models into that path unless this is set.
    const cfg = litellmConfig({
      models: { 'deepseek-v4-flash': { gateway: 'acme', id: 'deepseek-v4-flash-0731', contextWindow: 128000 } },
      gateways: { acme: { baseUrl: 'https://gateway.acme.example/v1', auth: 'api-key' } },
      ports: { router: 4100, litellm: 4000 },
      generate: {},
    }, 'sk-master');
    expect(cfg.litellm_settings.use_chat_completions_url_for_anthropic_messages).toBe(true);
  });

  it('maps a gateway name to an env var', () => {
    expect(envVarForGateway('acme')).toBe('SONATA_KEY_ACME');
    expect(envVarForGateway('open-router')).toBe('SONATA_KEY_OPEN_ROUTER');
  });
});

describe('LiteLLM config — unified [models] entries', () => {
  it('includes a unified model with a gateway route, keyed by its model key', () => {
    const cfg = litellmConfig({
      models: {},
      gateways: { acme: { baseUrl: 'https://gateway.acme.example/v1', auth: 'api-key' } },
      ports: { router: 4100, litellm: 4000 },
      generate: {},
    }, 'sk-master', {
      flash: { gateway: 'acme', id: 'deepseek-v4-flash-0731', contextWindow: 128000 },
    });
    expect(cfg.model_list).toHaveLength(1);
    expect(cfg.model_list[0].model_name).toBe('flash');
    expect(cfg.model_list[0].litellm_params.model).toBe('openai/deepseek-v4-flash-0731');
    expect(cfg.model_list[0].litellm_params.api_base).toBe('https://gateway.acme.example/v1');
  });

  it('skips a unified entry with no gateway route (harness-only)', () => {
    const cfg = litellmConfig({
      models: {},
      gateways: {},
      ports: { router: 4100, litellm: 4000 },
      generate: {},
    }, 'sk-master', {
      'harness-only': { harness: 'opencode', harnessId: 'vendorx/x' },
    });
    expect(cfg.model_list).toHaveLength(0);
  });

  it('lets a legacy native.models entry stay authoritative over a same-keyed unified entry', () => {
    const cfg = litellmConfig({
      models: { shared: { gateway: 'acme', id: 'native-id', contextWindow: 128000 } },
      gateways: { acme: { baseUrl: 'https://a.example/v1', auth: 'api-key' } },
      ports: { router: 4100, litellm: 4000 },
      generate: {},
    }, 'sk-master', {
      shared: { gateway: 'acme', id: 'unified-id', contextWindow: 128000 },
    });
    expect(cfg.model_list).toHaveLength(1);
    expect(cfg.model_list[0].litellm_params.model).toBe('openai/native-id');
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
    expect(codexConfig().model_list[0].model_info).toMatchObject({ mode: 'responses' });
  });

  it('declares the model as not supporting system messages', () => {
    // The Codex backend rejects any `role: system` with
    // `{"detail":"System messages are not allowed"}`, and LiteLLM's chatgpt
    // provider does not normalize it (BerriAI/litellm#22968; its fix, PR
    // #22967, was closed unmerged). Declaring this routes the prompt through
    // map_system_message_pt instead of emitting the rejected role.
    expect(codexConfig().model_list[0].model_info).toMatchObject({ supports_system_message: false });
  });

  it('declares it only for codex-oauth, which is the backend that refuses the role', () => {
    // An api-key gateway takes a system message perfectly well; folding it
    // into the user turn there would degrade the prompt for no reason.
    const plain = litellmConfig({
      models: { m: { gateway: 'acme', id: 'm', contextWindow: 128000 } },
      gateways: { acme: { baseUrl: 'https://acme.example/v1', auth: 'api-key' } },
      ports: { router: 4100, litellm: 4000 },
      generate: {},
    }, 'sk-master');
    expect(plain.model_list[0].model_info?.supports_system_message).toBeUndefined();
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
        'ds': { gateway: 'acme', id: 'deepseek-v4-flash-0731', contextWindow: 128000 },
      },
      gateways: {
        codex: { baseUrl: CODEX_OAUTH_BASE_URL, auth: 'codex-oauth' },
        acme: { baseUrl: 'https://gateway.acme.example/v1', auth: 'api-key' },
      },
      ports: { router: 4100, litellm: 4000 },
      generate: {},
    }, 'sk-master');

    const byName = Object.fromEntries(cfg.model_list.map((m) => [m.model_name, m]));
    expect(byName['gpt-5.6-luna'].litellm_params.model).toBe('chatgpt/gpt-5.6-luna');
    expect(byName['ds'].litellm_params.model).toBe('openai/deepseek-v4-flash-0731');
    expect(byName['ds'].litellm_params.api_key).toBe('os.environ/SONATA_KEY_ACME');
    expect(byName['ds'].model_info).toBeUndefined();
  });
});

describe('LiteLLM config — anthropic wire format', () => {
  const native: NativeConfig = {
    models: { 'custom-claude-clone': { gateway: 'custom', id: 'claude-clone', contextWindow: 128000 } },
    gateways: { custom: { baseUrl: 'https://example.com/v1', auth: 'api-key', wireFormat: 'anthropic' } },
    ports: { router: 4100, litellm: 4000 },
    generate: {},
  };

  it('routes through the anthropic custom_llm_provider instead of openai', () => {
    const config = litellmConfig(native, 'k');
    expect(config.model_list[0]!.litellm_params.model).toBe('anthropic/claude-clone');
  });

  it('still passes api_base and api_key, unlike the OAuth branches', () => {
    const config = litellmConfig(native, 'k');
    expect(config.model_list[0]!.litellm_params.api_base).toBe('https://example.com/v1');
    expect(config.model_list[0]!.litellm_params.api_key).toBe('os.environ/SONATA_KEY_CUSTOM');
  });

  it('sets no mode override — only codex-oauth needs one', () => {
    const config = litellmConfig(native, 'k');
    expect(config.model_list[0]!.model_info).toBeUndefined();
  });

  it('leaves an absent wire_format on the openai/<id> path, unchanged', () => {
    const openaiNative: NativeConfig = {
      ...native,
      gateways: { custom: { baseUrl: 'https://example.com/v1', auth: 'api-key' } },
    };
    const config = litellmConfig(openaiNative, 'k');
    expect(config.model_list[0]!.litellm_params.model).toBe('openai/claude-clone');
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
