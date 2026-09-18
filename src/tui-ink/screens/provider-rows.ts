import type { SonataConfig } from '../../config.js';
import { transportFor } from '../../native/providers.js';

/** One configured gateway as the providers screen draws it. */
export interface ProviderRow { gateway: string; auth: string; transport: string; models: string[] }

/**
 * Gateways and the native model keys that reach them.
 *
 * Transport is derived by the router's shared rule rather than repeated here:
 * an Anthropic api-key gateway is direct, while every other route uses LiteLLM.
 */
export function providerRows(config: SonataConfig): ProviderRow[] {
  const modelsByGateway = new Map<string, string[]>();
  for (const [key, model] of Object.entries(config.unifiedModels)) {
    if (model.gateway === undefined) continue;
    const models = modelsByGateway.get(model.gateway) ?? [];
    models.push(key);
    modelsByGateway.set(model.gateway, models);
  }
  return Object.entries(config.native?.gateways ?? {}).map(([gateway, config]) => ({
    gateway,
    auth: config.auth,
    transport: transportFor(config, gateway),
    models: modelsByGateway.get(gateway) ?? [],
  }));
}

/** Gateways configured but serving no unified native models. */
export function gatewaysServingNothing(rows: readonly ProviderRow[]): string[] {
  return rows.filter((row) => row.models.length === 0).map((row) => row.gateway);
}
