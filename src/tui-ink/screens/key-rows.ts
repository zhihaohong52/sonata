export interface KeyRow { gateway: string; source: string; hasKey: boolean }

export function keyRows(gateways: readonly string[], reports: ReadonlyArray<{ gateway: string; source: string | null }>): KeyRow[] {
  const sources = new Map(reports.map((report) => [report.gateway, report.source]));
  return gateways.map((gateway) => {
    const source = sources.get(gateway);
    return { gateway, source: source ?? 'no key', hasKey: source !== null && source !== undefined };
  });
}

export function gatewaysMissingKeys(rows: readonly KeyRow[]): string[] {
  return rows.filter((row) => !row.hasKey).map((row) => row.gateway);
}
