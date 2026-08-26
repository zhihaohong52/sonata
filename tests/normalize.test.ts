import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripAnsi, cleanPane, newLines } from '../src/normalize.js';

describe('stripAnsi', () => {
  it('removes colour and cursor sequences', () => {
    expect(stripAnsi('\u001b[0mhello\u001b[1;32m world\u001b[K')).toBe('hello world');
  });
});

describe('cleanPane', () => {
  it('drops blank and spinner-only lines and trims trailing space', () => {
    const raw = '\u001b[0m\nfoo   \n⠋\n⠙ thinking\n\nbar\n\n\n';
    expect(cleanPane(raw)).toEqual(['foo', '⠙ thinking', 'bar']);
  });

  it('normalises a real opencode pane', () => {
    const raw = readFileSync('tests/fixtures/opencode-pane.txt', 'utf8');
    expect(cleanPane(raw)).toEqual(['> build · deepseek-v4-flash', 'CTRL_OK']);
  });
});

describe('newLines', () => {
  it('returns everything when there is no previous state', () => {
    expect(newLines([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns only the appended tail', () => {
    expect(newLines(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('returns nothing when unchanged', () => {
    expect(newLines(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('handles scrolled-off content via suffix overlap', () => {
    expect(newLines(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['d']);
  });

  it('returns everything when there is no overlap at all', () => {
    expect(newLines(['a'], ['x', 'y'])).toEqual(['x', 'y']);
  });
});

import { parseConfig } from '../src/config.js';
import { migrateLegacyConfig } from '../src/normalize.js';

describe('migrateLegacyConfig', () => {
  it('merges routes, preserves distinct collisions, and seeds native-first tiers', () => {
    const config = parseConfig(`
[native.gateways."openai"]
base_url = "https://openai.example/v1"

[native.models."gpt-5.6-luna"]
gateway = "openai"
id = "gpt-5.6-luna"
context_window = 128000

[native.models."native-only"]
gateway = "openai"
id = "native-only"
context_window = 128000

[models."opencode-openai-gpt-5.6-luna"]
harness = "opencode"
id = "openai/gpt-5.6-luna"

[models."pi-openrouter-kimi-k3"]
harness = "pi"
id = "openrouter/kimi-k3"

[models."opencode-openai-native-only"]
harness = "opencode"
id = "openai/different-model"

[generate.roles]
code = ["opencode-openai-gpt-5.6-luna", "pi-openrouter-kimi-k3"]
review = ["opencode-openai-native-only"]

[generate.native]
code = ["gpt-5.6-luna", "native-only"]
review = ["native-only"]
`);
    const migrated = migrateLegacyConfig(config);
    expect(migrated.models['gpt-5.6-luna']).toMatchObject({
      gateway: 'openai', id: 'gpt-5.6-luna', harness: 'opencode', harnessId: 'openai/gpt-5.6-luna',
    });
    expect(migrated.models['kimi-k3']).toMatchObject({ harness: 'pi', harnessId: 'openrouter/kimi-k3' });
    expect(migrated.models['native-only']).toMatchObject({ gateway: 'openai', id: 'native-only' });
    expect(migrated.models['opencode-openai-native-only']).toMatchObject({ harness: 'opencode' });
    expect(migrated.tiers.code.simple).toEqual(['gpt-5.6-luna', 'native-only', 'kimi-k3']);
    expect(migrated.tiers.code.complex).toEqual(['gpt-5.6-luna', 'native-only', 'kimi-k3']);
    expect(migrated.tiers.review.simple).toEqual(['native-only', 'opencode-openai-native-only']);
  });

  it('never merges a legacy entry into either native model when their upstream ids collide', () => {
    // "openai-latest" and "anexto-latest" both normalize to "latest" — two
    // different gateways, no shared identity beyond the coincidence. A
    // legacy harness entry whose id also normalizes to "latest" must not be
    // silently merged into whichever of the two happened to be inserted
    // last: that would pair one provider's harness route with a different
    // provider's native route without anyone choosing that pairing.
    const config = parseConfig(`
[native.gateways."gw-a"]
base_url = "https://gw-a.example/v1"
[native.gateways."gw-b"]
base_url = "https://gw-b.example/v1"

[native.models."model-a"]
gateway = "gw-a"
id = "openai-latest"
context_window = 128000

[native.models."model-b"]
gateway = "gw-b"
id = "anexto-latest"
context_window = 128000

[models."harness-latest"]
harness = "opencode"
id = "openrouter/latest"

[generate.roles]
code = ["harness-latest"]

[generate.native]
code = ["model-a", "model-b"]
`);
    const migrated = migrateLegacyConfig(config);
    expect(migrated.models['model-a']).toEqual({ gateway: 'gw-a', id: 'openai-latest', contextWindow: 128000 });
    expect(migrated.models['model-b']).toEqual({ gateway: 'gw-b', id: 'anexto-latest', contextWindow: 128000 });
    // Kept under its own legacy key, harness-only — never merged into
    // model-a or model-b.
    expect(migrated.models['harness-latest']).toEqual({ harness: 'opencode', harnessId: 'openrouter/latest' });
    expect(migrated.tiers.code.simple).toEqual(['model-a', 'model-b', 'harness-latest']);
  });

  it('invents a distinct key rather than overwrite a native entry on an exact-key collision', () => {
    // A legacy harness key that is *already* normalized (so oldKey ===
    // candidate, e.g. [native.models."x"] and [models."x"]) and whose id does
    // not merge with the native entry's upstream used to fall back to
    // `models[oldKey]` — the same occupied slot the native entry already
    // holds — silently overwriting it. The native entry must survive intact
    // and the harness entry must land under a new suffixed key instead.
    const config = parseConfig(`
[native.gateways."gw"]
base_url = "https://gw.example/v1"

[native.models."x"]
gateway = "gw"
id = "native-alpha"
context_window = 128000

[models."x"]
harness = "opencode"
id = "openrouter/native-beta"

[generate.roles]
code = ["x"]

[generate.native]
code = ["x"]
`);
    const migrated = migrateLegacyConfig(config);
    expect(migrated.models['x']).toEqual({ gateway: 'gw', id: 'native-alpha', contextWindow: 128000 });
    expect(migrated.models['x-2']).toEqual({ harness: 'opencode', harnessId: 'openrouter/native-beta' });
    expect(migrated.tiers.code.simple).toEqual(['x', 'x-2']);
    expect(migrated.tiers.code.complex).toEqual(['x', 'x-2']);
  });

  it('keeps two harness routes to the same upstream model as separate entries', () => {
    // Two different harnesses reach the identical upstream id. Neither is
    // native, and both normalize to the same upstream, so a second would
    // otherwise silently overwrite the first's fields.
    const config = parseConfig(`
[models."opencode-openrouter-kimi-k3"]
harness = "opencode"
id = "openrouter/kimi-k3"

[models."pi-openrouter-kimi-k3"]
harness = "pi"
id = "openrouter/kimi-k3"
`);
    const migrated = migrateLegacyConfig(config);
    const entries = Object.values(migrated.models);
    const opencode = entries.find((m) => m.harness === 'opencode');
    const pi = entries.find((m) => m.harness === 'pi');
    expect(opencode).toMatchObject({ harness: 'opencode', harnessId: 'openrouter/kimi-k3' });
    expect(pi).toMatchObject({ harness: 'pi', harnessId: 'openrouter/kimi-k3' });
    expect(entries).toHaveLength(2);
  });
});
