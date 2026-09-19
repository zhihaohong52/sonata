import React from 'react';
import { Box, Text } from 'ink';
import { keyReport } from '../../native/credentials.js';
import { loadConfigForScreen } from './screen-config.js';
import { keyRows, gatewaysMissingKeys } from './key-rows.js';

/** Show credential sources without exposing or editing secret values. */
export function KeysScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const loaded = loadConfigForScreen(cwd, home);
  if (!loaded.ok) {
    return <Box flexDirection="column"><Text color="yellow">{loaded.message}</Text><Box marginTop={1}><Text dimColor>esc back</Text></Box></Box>;
  }
  const gateways = Object.keys(loaded.config.native?.gateways ?? {});
  const rows = keyRows(gateways, keyReport(gateways, home));
  const missing = new Set(gatewaysMissingKeys(rows));
  return (
    <Box flexDirection="column">
      <Text bold>Keys</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row) => <Text key={row.gateway} color={missing.has(row.gateway) ? 'yellow' : undefined}>{row.gateway}  {row.source}</Text>)}
      </Box>
      <Box marginTop={1}><Text dimColor>sonata auth add &lt;gateway&gt; to add a credential</Text></Box>
      <Box marginTop={1}><Text dimColor>esc back</Text></Box>
    </Box>
  );
}
