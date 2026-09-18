import React from 'react';
import { Box, Text } from 'ink';
import type { Check } from '../../commands/doctor.js';
import { overviewRows, summarise } from './overview-rows.js';

/**
 * Doctor's findings as the TUI's home screen.
 *
 * This inverts today's flow, where `doctor` names a problem and the reader
 * then goes to find the command that fixes it — the five distinct reasons
 * `diagnoseRouteAuto` can give for an unrouted config become five rows.
 */
export function OverviewScreen({ checks }: { checks: readonly Check[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>sonata — {summarise(checks)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {overviewRows(checks).map((row) => (
          <Text key={row.name}>
            <Text color={row.ok ? 'green' : 'yellow'}>{row.ok ? '  ok  ' : '  !   '}</Text>
            {row.name}
            {row.detail === '' ? '' : `  ${row.detail}`}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}><Text dimColor>b budget · m models · p providers · t tiers · q quit</Text></Box>
    </Box>
  );
}
