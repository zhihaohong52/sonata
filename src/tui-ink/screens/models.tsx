import React from 'react';
import { Box, Text } from 'ink';
import { loadConfigForScreen } from './screen-config.js';
import { modelRows, modelsUntiered } from './models-rows.js';

/** Show every configured model and whether a tier can reach it. */
export function ModelsScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const loaded = loadConfigForScreen(cwd, home);
  if (!loaded.ok) {
    return <Box flexDirection="column"><Text color="yellow">{loaded.message}</Text><Box marginTop={1}><Text dimColor>esc back</Text></Box></Box>;
  }
  const rows = modelRows(loaded.config);
  const untiered = new Set(modelsUntiered(rows));
  return (
    <Box flexDirection="column">
      <Text bold>Models</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row) => (
          <Text key={row.key} color={untiered.has(row.key) ? 'yellow' : undefined}>
            {row.key}  {row.route}{row.tiers.length === 0 ? '  ! untiered' : `  ${row.tiers.join(', ')}`}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}><Text dimColor>esc back</Text></Box>
    </Box>
  );
}
