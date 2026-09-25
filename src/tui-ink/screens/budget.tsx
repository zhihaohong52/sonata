import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useInput } from 'ink';
import { configPath } from '../../config.js';
import { usePalette } from '../theme-context.js';
import { Screen } from '../components/screen.js';
import { loadConfigForScreen } from './screen-config.js';
import { writeBudget } from './budget-write.js';

/** Edit `[budget] daily_usd` — the only config value with a direct dollar consequence. */
export function BudgetScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const palette = usePalette();
  // `configPath` returns `string | null`, and `loadConfig` *throws*
  // `NoConfigError` when there is none — so the null check comes first and the
  // read is guarded rather than defaulted.
  const path = configPath(cwd, home);
  const loaded = loadConfigForScreen(cwd, home);
  const [draft, setDraft] = useState<string>(() => {
    if (!loaded.ok) return '';
    const current = loaded.config.budget;
    return current === undefined ? '' : String(current.dailyUsd);
  });
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);

  useInput((input, key) => {
    if (key.return) {
      if (!loaded.ok) { setNote(loaded.message); setSaved(false); return; }
      if (path === null) { setNote('no sonata.toml — run `sonata init` first'); setSaved(false); return; }
      const trimmed = draft.trim();
      if (trimmed === '') { writeBudget(path, undefined); setNote('cap removed'); setSaved(true); return; }
      const value = Number(trimmed);
      // Refused here for the reason `parseConfig` refuses it: a cap's only
      // effect is a refusal that has not happened yet, so one silently dropped
      // for being the wrong type reads exactly like one that is working.
      if (!Number.isFinite(value) || value <= 0) {
        setNote('must be a positive number of US dollars'); setSaved(false); return;
      }
      writeBudget(path, value);
      setNote(`cap set to $${value} per day`);
      setSaved(true);
      return;
    }
    if (key.delete || key.backspace) { setDraft((d) => d.slice(0, -1)); setNote(''); return; }
    if (/^[0-9.]$/.test(input)) { setDraft((d) => d + input); setNote(''); }
  });

  return (
    <Screen
      title="Budget"
      note="priced spend per UTC day"
      footer={loaded.ok ? 'type a number   enter save   esc back' : 'esc back'}
    >
      <Box>
        <Text color={palette.MUTED}>{'daily_usd   '}</Text>
        {/* The caret is the whole affordance: nothing else on this screen
            says it takes typing, and an empty field with no caret reads as a
            value of zero rather than as an absent cap. */}
        <Text color={palette.ACCENT}>{draft === '' ? '' : '$'}</Text>
        <Text bold color={palette.TEXT}>{draft === '' ? 'no cap' : draft}</Text>
        <Text color={palette.ACCENT}>▏</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={palette.MUTED}>Counts priced volume from both lanes, so it can be exceeded:</Text>
        <Text color={palette.MUTED}>unpriced models are not bounded, and a dispatch run is counted when it finishes.</Text>
      </Box>
      {!loaded.ok && <Box marginTop={1}><Text color={palette.MID}>{loaded.message}</Text></Box>}
      {note !== '' && loaded.ok && (
        <Box marginTop={1}><Text color={saved ? palette.LOW : palette.MID}>{note}</Text></Box>
      )}
    </Screen>
  );
}
