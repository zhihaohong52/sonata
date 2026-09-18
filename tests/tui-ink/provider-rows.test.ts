import { describe, expect, it } from 'vitest';
import type { SonataConfig } from '../../src/config.js';
import { gatewaysServingNothing, providerRows } from '../../src/tui-ink/screens/provider-rows.js';

function config(): SonataConfig {
  return {
    models: {}, unifiedModels: {
      first: { gateway: 'anthropic', id: 'claude-model' },
      second: { gateway: 'acme', id: 'acme-model' },
      third: { gateway: 'acme', id: 'acme-other' },
      oauthModel: { gateway: 'codex', id: 'codex-model' },
    },
    generate: { roles: {} },
    native: {
      models: {},
      gateways: {
        anthropic: { baseUrl: 'https://anthropic.example', auth: 'api-key', provider: 'anthropic' },
        acme: { baseUrl: 'https://acme.example', auth: 'api-key' },
        codex: { baseUrl: 'https://chatgpt.example', auth: 'codex-oauth' },
        empty: { baseUrl: 'https://empty.example', auth: 'api-key' },
      },
      ports: { router: 4100, litellm: 4000 }, generate: {},
    },
    run: { tailWindowSeconds: 1, stallTimeoutSeconds: 1, runTimeoutSeconds: 1, dispatchWindowSeconds: 1 },
  };
}

describe('providerRows', () => {
  it('derives transport and preserves gateway and model order', () => {
    expect(providerRows(config())).toEqual([
      { gateway: 'anthropic', auth: 'api-key', transport: 'direct', models: ['first'] },
      { gateway: 'acme', auth: 'api-key', transport: 'litellm', models: ['second', 'third'] },
      { gateway: 'codex', auth: 'codex-oauth', transport: 'litellm', models: ['oauthModel'] },
      { gateway: 'empty', auth: 'api-key', transport: 'litellm', models: [] },
    ]);
  });
});

describe('gatewaysServingNothing', () => {
  it('names configured gateways without native models', () => {
    expect(gatewaysServingNothing(providerRows(config()))).toEqual(['empty']);
  });
});
