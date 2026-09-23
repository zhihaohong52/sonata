import React from 'react';
import { Text } from 'ink';
import { STATE } from '../theme.js';
import { usePalette } from '../theme-context.js';
import { Message, Screen, count, fit, ruleWidth } from '../components/screen.js';
import { loadConfigForScreen } from './screen-config.js';
import { modelRows, modelsUntiered, summariseTiers } from './models-rows.js';

/** Show every configured model and whether a tier can reach it. */
export function ModelsScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const palette = usePalette();
  const loaded = loadConfigForScreen(cwd, home);
  if (!loaded.ok) return <Message text={loaded.message} title="Models" />;

  const rows = modelRows(loaded.config);
  const untiered = new Set(modelsUntiered(rows));
  // Capped at 40% of the page. Grown to the longest identifier it let one
  // long key push every row past the page and wrap, whatever the budget for
  // the details column said.
  const width = Math.min(Math.max(...rows.map((row) => row.key.length), 4), Math.floor(ruleWidth() * 0.4));
  // 4 for the stroke, 2 for the gap after the name: what is left is shared by
  // the route and the tier summary, the two fields that actually grow.
  // No floor: a floor is how a row outgrows a narrow page.
  const rest = Math.max(0, ruleWidth() - 4 - width - 2);

  return (
    <Screen
      title="Models"
      note={untiered.size === 0 ? `${count(rows.length, 'model')}, all tiered` : `${untiered.size} of ${rows.length} unreachable`}
      footer="esc back   q quit"
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
          <Text key={row.key} wrap="truncate-end">
            <Text color={out ? palette.MID : palette.MUTED}>{(out ? STATE.held.mark : STATE.live.mark).padEnd(4)}</Text>
            <Text color={out ? palette.MID : palette.TEXT}>{fit(row.key, width).padEnd(width + 2)}</Text>
            <Text color={palette.MUTED}>{fit(`${row.route}  ${summariseTiers(row.tiers)}`, rest)}</Text>
          </Text>
        );
      })}
    </Screen>
  );
}
