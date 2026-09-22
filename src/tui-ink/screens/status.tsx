import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { readRows } from '../../ledger.js';
import { recentRoutes, type RouteLine } from '../../commands/status.js';
import { routerPorts } from '../../commands/ports.js';
import { isSonataRouter, serveHealthUrl } from '../../commands/serve.js';
import { INK, STATE, columns } from '../theme.js';

/**
 * What the router just did, as a board.
 *
 * `sonata status` prints the same facts as lines of text. This is the same
 * data in the board grammar, and it is the screen a reader reaches when a
 * dispatch has failed and they want to know why — so the failed attempts
 * behind a route matter as much as the route that served.
 *
 * Scoped to the project, like `sonata status` itself: the ledger is
 * machine-wide and a reader inside one project is not asking about another.
 */
export function StatusScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const [up, setUp] = useState<boolean | undefined>(undefined);
  const [routes, setRoutes] = useState<RouteLine[] | undefined>(undefined);
  const port = routerPorts(home).router;

  useEffect(() => {
    let cancelled = false;
    // Bounded: a router that accepts the connection and never answers would
    // otherwise hang this screen, which is the fault it exists to report.
    isSonataRouter(port, ((url: string, init?: RequestInit) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(3000) })) as typeof fetch)
      .then((alive) => { if (!cancelled) setUp(alive); })
      .catch(() => { if (!cancelled) setUp(false); });
    try {
      const rows = readRows(home, Date.now() - 3_600_000)
        .filter((row) => row.project === undefined || row.project === cwd);
      setRoutes(recentRoutes(rows, 12));
    } catch {
      // An unreadable ledger is not a reason to show nothing: the router's own
      // state is still worth reporting, and an empty list says so below.
      setRoutes([]);
    }
    return () => { cancelled = true; };
  }, [port, home, cwd]);

  const col = columns(process.stdout.columns ?? 96);

  return (
    <Box flexDirection="column">
      <Text bold>router</Text>
      <Text color={INK.RULE}>{'─'.repeat(col.total)}</Text>
      <Text>
        <Text color={up === true ? INK.ACCENT : INK.MUTED}>
          {up === undefined ? STATE.unscored.mark : up ? STATE.lead.mark : STATE.cooled.mark}
        </Text>
        <Text color={INK.MUTED}>
          {up === undefined ? '  checking…' : up ? `  up on port ${port}` : `  not running on port ${port}`}
        </Text>
      </Text>
      {up === false && (
        <Text color={INK.MID}>   Start it with `sonata serve --daemon`, or run `sonata doctor` to find out why.</Text>
      )}

      <Box marginTop={1}><Text bold>routes, last hour</Text></Box>
      <Text color={INK.RULE}>{'─'.repeat(col.total)}</Text>
      {routes === undefined && <Text color={INK.MUTED}>reading the ledger…</Text>}
      {routes !== undefined && routes.length === 0 && (
        // An empty screen is an invitation, not a void: say what would put
        // something here rather than printing "none".
        <Text color={INK.MUTED}>
          Nothing routed from this project in the last hour. Dispatch a tier agent and it appears here.
        </Text>
      )}
      {routes?.map((line, i) => {
        const failed = line.served === undefined;
        const mark = failed ? STATE.cooled : STATE.live;
        return (
          <Box key={`${line.alias}-${i}`} flexDirection="column">
            <Box>
              <Text color={failed ? INK.HIGH : INK.MUTED}>{`${String(line.status).padStart(4)} `}</Text>
              <Text>{line.alias.padEnd(Math.min(26, col.name))}</Text>
              <Text color={INK.MUTED}>{mark.mark} </Text>
              <Text color={failed ? INK.MUTED : undefined}>
                {line.served ?? 'no candidate served'}
              </Text>
              <Text color={INK.MUTED}>{`  ${line.input} in / ${line.output} out`}</Text>
            </Box>
            {/* Failed attempts are why a dispatch died, so they are not a detail. */}
            {line.attempts.map((a) => (
              <Box key={a.key}>
                <Text color={INK.MUTED}>{'      '}</Text>
                <Text color={INK.MUTED}>{STATE.cooled.mark} {a.key} </Text>
                <Text color={INK.HIGH}>{a.status}</Text>
              </Box>
            ))}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={INK.MUTED}>esc back</Text>
      </Box>
    </Box>
  );
}
