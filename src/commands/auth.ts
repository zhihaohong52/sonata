import { keyReport, removeSonataKey, writeSonataKey } from '../native/credentials.js';
import { loadConfig, isOauthGatewayAuth } from '../config.js';
import { credentialDir, loginGateway } from '../native/oauth-login.js';

export function cmdAuthList(opts: { home: string; gateways: string[] }): { text: string } {
  const text = keyReport(opts.gateways, opts.home)
    .map(({ gateway, source }) => `${gateway}: ${source === null ? 'no key' : `key from ${source}`}`)
    .join('\n');
  return { text };
}

export function cmdAuthAdd(opts: { home: string; gateway: string; key: string }): void {
  writeSonataKey(opts.home, opts.gateway, opts.key);
}

export function cmdAuthRemove(opts: { home: string; gateway: string }): void {
  removeSonataKey(opts.home, opts.gateway);
}

export async function cmdAuthLogin(opts: {
  home: string;
  cwd: string;
  gateway: string;
  out: (line: string) => void;
  interpreter?: string;
}): Promise<void> {
  const config = loadConfig(opts.cwd, opts.home);
  const gateways = config.native?.gateways ?? {};
  const gateway = gateways[opts.gateway];
  if (!gateway) {
    throw new Error(
      `sonata auth login: no native gateway "${opts.gateway}". ` +
      `Configured: ${Object.keys(gateways).join(', ') || '(none)'}`,
    );
  }
  if (!isOauthGatewayAuth(gateway.auth)) {
    throw new Error(
      `sonata auth login: gateway "${opts.gateway}" is auth = "api-key" — ` +
      `store a key instead: sonata auth add ${opts.gateway}`,
    );
  }

  opts.out(`Logging in to ${opts.gateway}. A code appears below; enter it in your browser.`);
  const result = await loginGateway({
    home: opts.home,
    gateway: opts.gateway,
    auth: gateway.auth,
    progress: { line: opts.out },
    interpreter: opts.interpreter,
  });
  if (!result.ok) throw new Error(`sonata auth login: ${result.problem}`);

  opts.out(`Logged in. Credential stored in ${credentialDir(opts.home, opts.gateway)}`);
  opts.out(`Record it in sonata.toml under [native.gateways.${opts.gateway}]: credential_source = "sonata"`);
}
