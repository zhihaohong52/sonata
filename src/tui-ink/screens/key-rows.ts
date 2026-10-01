import { decisionGatewayFor } from '../../native/auto-route.js';

export interface KeyRow { gateway: string; source: string; hasKey: boolean }

/**
 * The row for the key `[auto_route]`'s decision server needs, reported under
 * the gateway its host files one under (`typesafe`, `openrouter` or the shared
 * `auto-route`).
 *
 * `hasKey` is false only for a hosted server that insists on a credential and
 * has none: a self-hosted or loopback one is asked for nothing, and "no key
 * needed" is the truth about it — flagging it as a missing credential is the
 * same misread `keyRows` exists to rule out for subscription gateways.
 */
export function autoRouteKeyRow(baseUrl: string, source: string | null): KeyRow {
  let host = baseUrl;
  try { host = new URL(baseUrl).hostname; } catch { /* the URL itself names it */ }
  const gateway = `auto-route → ${host}`;
  if (source !== null) return { gateway, source, hasKey: true };
  const required = decisionGatewayFor(baseUrl) !== 'auto-route';
  return required
    ? { gateway, source: 'no key', hasKey: false }
    : { gateway, source: 'no key needed', hasKey: true };
}

/**
 * Where each gateway's credential comes from, and whether it has one.
 *
 * `auth` is consulted because a **subscription gateway has no bearer key and
 * cannot have one**. `keyReport` answers `null` for it truthfully — there is
 * no key in the store — and reading that as "needs a credential" flagged a
 * perfectly working `codex-oauth` gateway in alarm colour with a fix
 * (`sonata auth add`) that would not have helped. This repository has the same
 * bug on record from the other direction, where opencode's OAuth entries made
 * doctor report "no key" for a credential sitting on disk.
 *
 * The distinction is the one the config already draws: an api-key gateway is
 * authenticated by a stored bearer, an OAuth one by a subscription credential
 * LiteLLM holds and refreshes. Only the first can be missing one.
 */
export function keyRows(
  gateways: ReadonlyArray<string | { gateway: string; auth?: string }>,
  reports: ReadonlyArray<{ gateway: string; source: string | null }>,
): KeyRow[] {
  const sources = new Map(reports.map((report) => [report.gateway, report.source]));
  return gateways.map((entry) => {
    const gateway = typeof entry === 'string' ? entry : entry.gateway;
    const auth = typeof entry === 'string' ? undefined : entry.auth;
    const oauth = auth !== undefined && auth.endsWith('-oauth');
    const source = sources.get(gateway);
    if (source !== null && source !== undefined) return { gateway, source, hasKey: true };
    // Named by its kind rather than left blank: "subscription" tells the
    // reader the gateway is authenticated and by what, where an empty cell
    // reads as the missing key this branch exists to rule out.
    if (oauth) return { gateway, source: `${auth.replace('-oauth', '')} subscription`, hasKey: true };
    return { gateway, source: 'no key', hasKey: false };
  });
}

/** The gateways with no usable credential. An OAuth gateway is never among them — see `keyRows`. */
export function gatewaysMissingKeys(rows: readonly KeyRow[]): string[] {
  return rows.filter((row) => !row.hasKey).map((row) => row.gateway);
}
