/**
 * The environment variable a gateway's key reaches LiteLLM through.
 *
 * Its own module so `parseConfig` can refuse two gateways that would share
 * one variable without importing the LiteLLM config builder: a test that
 * stubs that module must not thereby break config loading.
 */
export function envVarForGateway(gateway: string): string {
  // Every character outside A-Z and 0-9 becomes `_`, so any name — a space, a
  // dot, a slash — yields a plain variable name a LiteLLM `os.environ/` reference
  // can hold. Two names that fold to one variable are refused where they are
  // written (`parseConfig`) and where they are merged (serve).
  return `SONATA_KEY_${gateway.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
