import { describe, expect, it } from 'vitest';
import { cmdUpgrade, type UpgradeDeps } from '../../src/commands/upgrade.js';

function deps(over: Partial<UpgradeDeps> & { latest?: string; ok?: boolean }) {
  const lines: string[] = [];
  const ran: string[][] = [];
  const d: UpgradeDeps = {
    name: '@zhihaohong52/sonata',
    installed: '0.15.5',
    latestVersion: async () => over.latest,
    run: async (command) => { ran.push(command); return over.ok ?? true; },
    out: (line) => lines.push(line),
    ...over,
  };
  return { d, lines, ran };
}

describe('cmdUpgrade', () => {
  it('installs the latest release when it is newer', async () => {
    const { d, lines, ran } = deps({ latest: '0.16.0' });
    expect(await cmdUpgrade(d)).toBe(0);
    expect(ran).toEqual([['npm', 'install', '-g', '@zhihaohong52/sonata@0.16.0']]);
    expect(lines.at(-1)).toMatch(/sonata restart/);
  });

  it('does nothing when already on the latest', async () => {
    const { d, lines, ran } = deps({ latest: '0.15.5' });
    expect(await cmdUpgrade(d)).toBe(0);
    expect(ran).toEqual([]);
    expect(lines).toEqual(['sonata 0.15.5 is the latest release.']);
  });

  // `npm install -g` over an `npm link` replaces the link with the published
  // package, so the clone silently stops being what runs.
  it('refuses a development install without touching it', async () => {
    const { d, lines, ran } = deps({ latest: '0.16.0', devRoot: '/src/sonata' });
    expect(await cmdUpgrade(d)).toBe(1);
    expect(ran).toEqual([]);
    expect(lines.join('\n')).toMatch(/development install \(\/src\/sonata\)[\s\S]*git pull && npm run build/);
  });

  it('fails when the registry cannot be read', async () => {
    const { d, ran } = deps({ latest: undefined });
    expect(await cmdUpgrade(d)).toBe(1);
    expect(ran).toEqual([]);
  });

  it('reports a failed install', async () => {
    const { d, lines } = deps({ latest: '0.16.0', ok: false });
    expect(await cmdUpgrade(d)).toBe(1);
    expect(lines.at(-1)).toMatch(/still installed/);
  });
});
