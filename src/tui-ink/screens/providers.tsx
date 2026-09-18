import React from 'react';
import { Box, Text } from 'ink';
import { loadConfigForScreen } from './screen-config.js';
import { gatewaysServingNothing, providerRows } from './provider-rows.js';

/** Show configured gateways, their transport, and the models using them. */
export function ProvidersScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const loaded = loadConfigForScreen(cwd, home);
  if (!loaded.ok) {
    return <Box flexDirection="column"><Text color="yellow">{loaded.message}</Text><Box marginTop={1}><Text dimColor>esc back</Text></Box></Box>;
  }
  const rows = providerRows(loaded.config);
  const empty = new Set(gatewaysServingNothing(rows));
  return (
    <Box flexDirection="column">
      <Text bold>Providers</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row) => (
          <Text key={row.gateway} color={empty.has(row.gateway) ? 'yellow' : undefined}>
            {row.gateway}  {row.auth}  {row.transport}  {row.models.length === 0 ? '! no models' : row.models.join(', ')}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}><Text dimColor>esc back</Text></Box>
    </Box>
  );
}
