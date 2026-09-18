import { describe, expect, it } from 'vitest';
import { seededRankingFor, tierPickerKeys } from '../../src/tui-ink/app-state.js';

describe('tier picker universe', () => {
  it('withholds a saved key whose native gateway is no longer selected', () => {
    const selected = ['live-a', 'live-b'];
    const saved = ['live-a', 'deleted-gateway-model'];
    const pickerUniverse = [...selected, 'deleted-gateway-model'];

    expect(tierPickerKeys(selected, saved, pickerUniverse)).toEqual(selected);
  });

  it('makes screen confirmation and bulk acceptance seed the same ranking', () => {
    const rankable = ['live-a', 'live-b'];
    const saved = ['live-a', 'deleted-gateway-model'];
    const pickerUniverse = [...rankable, 'deleted-gateway-model'];
    const screenRows = tierPickerKeys(rankable, saved, pickerUniverse);
    const screenSeed = saved.filter((key) => screenRows.includes(key));

    expect(seededRankingFor(saved, rankable, rankable, pickerUniverse))
      .toEqual(screenSeed);
  });

  it('preserves a genuinely harness-only saved key as a fallback row', () => {
    const rankable = ['live-a'];
    const saved = ['live-a', 'harness-only'];
    const nativeUniverse = ['live-a'];

    expect(tierPickerKeys(rankable, saved, nativeUniverse))
      .toEqual(['live-a', 'harness-only']);
    expect(seededRankingFor(saved, rankable, rankable, nativeUniverse))
      .toEqual(saved);
  });

  it('preserves a selected saved key that ranking excludes for lacking task cost', () => {
    const rankable = ['live-a'];
    const saved = ['live-a', 'selected-but-uncosted'];
    // The selected uncosted key is deliberately omitted from the native
    // withholding universe so a cost-filtered screen cannot erase it.
    const nativeUniverse = ['live-a'];

    expect(tierPickerKeys(rankable, saved, nativeUniverse))
      .toEqual(saved);
    expect(seededRankingFor(saved, rankable, rankable, nativeUniverse))
      .toEqual(saved);
  });
});
