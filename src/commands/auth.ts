import { keyReport, removeSonataKey, writeSonataKey } from '../native/credentials.js';

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
