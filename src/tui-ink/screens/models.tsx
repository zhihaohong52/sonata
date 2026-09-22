import React from 'react';
import { Text } from 'ink';
import { STATE } from '../theme.js';
import { usePalette } from '../theme-context.js';
import { Message, Screen, count } from '../components/screen.js';
import { loadConfigForScreen } from './screen-config.js';
import { modelRows, modelsUntiered, summariseTiers } from './models-rows.js';

/** Show every configured model and whether a tier can reach it. */
export function ModelsScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const palette = usePalette();
  const loaded = loadConfigForScreen(cwd, home);
  if (!loaded.ok) return <Message text={loaded.message} title="Models" />;

  const rows = modelRows(loaded.config);
  const untiered = new Set(modelsUntiered(rows));
  const width = Math.max(...rows.map((row) => row.key.length), 4);

  return (
    <Screen
      title="Models"
      note={untiered.size === 0 ? `${count(rows.length, 'model')}, all tiered` : `${untiered.size} of ${rows.length} unreachable`}
      footer="esc back"
    >
      {rows.length === 0 && (
        <Text color={palette.MUTED}>No models configured. `sonata init` picks them from what your gateways serve.</Text>
      )}
      {rows.map((row) => {
        // An untiered model is `held`, not an error: it is in the config, it
        // simply has no tier that names it, so no dispatch can reach it. The
        // stroke carries that and the colour agrees — strip the colour and the
        // row still says which ones are out of circuit.
        const out = untiered.has(row.key);
        return (
          <Text key={row.key}>
            <Text color={out ? palette.MID : palette.MUTED}>{(out ? STATE.held.mark : STATE.live.mark).padEnd(4)}</Text>
            <Text color={out ? palette.MID : undefined}>{row.key.padEnd(width + 2)}</Text>
            <Text color={palette.MUTED}>{row.route}</Text>
            <Text color={palette.MUTED}>{`  ${summariseTiers(row.tiers)}`}</Text>
          </Text>
        );
      })}
    </Screen>
  );
}
