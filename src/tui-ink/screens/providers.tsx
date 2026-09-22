import React from 'react';
import { Text } from 'ink';
import { STATE } from '../theme.js';
import { usePalette } from '../theme-context.js';
import { Message, Screen, count } from '../components/screen.js';
import { loadConfigForScreen } from './screen-config.js';
import { gatewaysServingNothing, providerRows } from './provider-rows.js';

/** Show configured gateways, their transport, and the models using them. */
export function ProvidersScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const palette = usePalette();
  const loaded = loadConfigForScreen(cwd, home);
  if (!loaded.ok) return <Message text={loaded.message} title="Providers" />;

  const rows = providerRows(loaded.config);
  const empty = new Set(gatewaysServingNothing(rows));
  const width = Math.max(...rows.map((row) => row.gateway.length), 7);

  return (
    <Screen
      title="Providers"
      note={empty.size === 0 ? count(rows.length, 'gateway') : `${empty.size} of ${rows.length} serve nothing`}
      footer="esc back"
    >
      {rows.length === 0 && (
        <Text color={palette.MUTED}>No gateways configured. `sonata init` adds them, by import or by hand.</Text>
      )}
      {rows.map((row) => {
        // A gateway serving no models is `held` rather than broken: it is
        // reachable and authenticated, nothing routes through it. That costs
        // nothing until it is the gateway you thought was carrying the work.
        const idle = empty.has(row.gateway);
        return (
          <Text key={row.gateway}>
            <Text color={idle ? palette.MID : palette.MUTED}>{(idle ? STATE.held.mark : STATE.live.mark).padEnd(4)}</Text>
            <Text color={idle ? palette.MID : undefined}>{row.gateway.padEnd(width + 2)}</Text>
            <Text color={palette.MUTED}>{`${row.auth}  ${row.transport}`}</Text>
            <Text color={palette.MUTED}>{row.models.length === 0 ? '  no models' : `  ${row.models.join(', ')}`}</Text>
          </Text>
        );
      })}
    </Screen>
  );
}
