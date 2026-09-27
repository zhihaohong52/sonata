/**
 * The environment variable a gateway's key reaches LiteLLM through.
 *
 * Its own module so `parseConfig` can refuse two gateways that would share
 * one variable without importing the LiteLLM config builder: a test that
 * stubs that module must not thereby break config loading.
 */
export function envVarForGateway(gateway: string): string {
  return `SONATA_KEY_${gateway.toUpperCase().replace(/-/g, '_')}`;
}
