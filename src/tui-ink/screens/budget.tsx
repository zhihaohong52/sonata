import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { configPath, loadConfig } from '../../config.js';
import { writeBudget } from './budget-write.js';

/** Edit `[budget] daily_usd` — the only config value with a direct dollar consequence. */
export function BudgetScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  // `configPath` returns `string | null`, and `loadConfig` *throws*
  // `NoConfigError` when there is none — so the null check comes first and the
  // read is guarded rather than defaulted.
  const path = configPath(cwd, home);
  const [draft, setDraft] = useState<string>(() => {
    if (path === null) return '';
    const current = loadConfig(cwd, home).budget;
    return current === undefined ? '' : String(current.dailyUsd);
  });
  const [note, setNote] = useState('');

  useInput((input, key) => {
    if (key.return) {
      if (path === null) { setNote('no sonata.toml — run sonata init first'); return; }
      const trimmed = draft.trim();
      if (trimmed === '') { writeBudget(path, undefined); setNote('cap removed'); return; }
      const value = Number(trimmed);
      // Refused here for the reason `parseConfig` refuses it: a cap's only
      // effect is a refusal that has not happened yet, so one silently dropped
      // for being the wrong type reads exactly like one that is working.
      if (!Number.isFinite(value) || value <= 0) { setNote('must be a positive number of US dollars'); return; }
      writeBudget(path, value);
      setNote(`cap set to $${value}/day`);
      return;
    }
    if (key.delete || key.backspace) { setDraft((d) => d.slice(0, -1)); setNote(''); return; }
    if (/^[0-9.]$/.test(input)) { setDraft((d) => d + input); setNote(''); }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Budget — priced spend per UTC day</Text>
      <Box marginTop={1}><Text>daily_usd: {draft === '' ? '(no cap)' : draft}</Text></Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Counts priced volume on the native path only.</Text>
        <Text dimColor>A `sonata dispatch` run never transits the router.</Text>
      </Box>
      {note !== '' && <Box marginTop={1}><Text color="yellow">{note}</Text></Box>}
      <Box marginTop={1}><Text dimColor>enter save · esc back</Text></Box>
    </Box>
  );
}
