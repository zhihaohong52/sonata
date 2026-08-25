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
});
