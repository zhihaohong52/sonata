import React from 'react';
import { Box, Text } from 'ink';
import type { Check } from '../../commands/doctor.js';
import { STATE } from '../theme.js';
import { overviewRows, summarise } from './overview-rows.js';
import { Menu, type MenuItem } from '../components/menu.js';
import { usePalette } from '../theme-context.js';
import type { Step } from '../steps.js';

/**
 * Home: what needs attention, then where to go.
 *
 * Only failing checks are drawn. A wall of green is the shape a reader learns
 * to skip, and the one amber row in the middle of it is exactly what they
 * skip past — so a healthy machine says so in a single line and gets out of
 * the way.
 */
export function OverviewScreen({
  checks,
  items,
  cursor,
}: {
  checks: readonly Check[];
  items: ReadonlyArray<MenuItem<Step>>;
  cursor: number;
}): React.ReactElement {
  const palette = usePalette();
  const rows = overviewRows(checks);

  return (
    <Box flexDirection="column">
      <Text bold color={palette.TEXT}>sonata</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.length === 0 && (
          <Text color={palette.MUTED}>
            {summarise(checks)}
            {checks.length > 0 ? ' · sonata doctor lists them' : ''}
          </Text>
        )}
        {rows.map((row) => (
          <Box key={row.name} flexDirection="column">
            <Box>
              {/* A stroke, not a glyph. `theme.ts` states the rule the first
                  draft of this screen broke: ink only, no emoji standing in
                  for an icon — and `⚠` is exactly that, on the one screen
                  whose only content it marks. `STATE.cooled` already carries
                  this meaning and is what `keys.tsx` reaches for in the same
                  situation, so the home screen now speaks the same vocabulary
                  as every screen it leads to. */}
              <Text color={palette.MID}>{`  ${STATE.cooled.mark}  `}</Text>
              <Text bold color={palette.TEXT}>{row.name}</Text>
            </Box>
            {row.detail !== '' && (
              // The fix belongs beside the fault: a finding that names the
              // problem and leaves the reader to find the command is half an
              // answer, and doctor's details already carry the command.
              <Box><Text color={palette.MUTED}>{`     ${row.detail}`}</Text></Box>
            )}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Menu items={items} cursor={cursor} label="menu" />
      </Box>
    </Box>
  );
}
