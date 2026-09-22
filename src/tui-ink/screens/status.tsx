import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { readRows } from '../../ledger.js';
import { projectTenant, recentRoutes, scopeRows, type RouteLine } from '../../commands/status.js';
import { routerPorts } from '../../commands/ports.js';
import { isSonataRouter, serveHealthUrl } from '../../commands/serve.js';
import { STATE, columns, usableWidth } from '../theme.js';
import { fit } from '../components/screen.js';
import { usePalette } from '../theme-context.js';
import { agoLabel, localTime, routesThatFit, statusColumns, STATUS_POLL_MS } from './status-poll.js';

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
export function StatusScreen({ cwd, home, global: initialGlobal = false }: {
  cwd: string;
  home: string;
  /** Start on every project's routes rather than this one's; `sonata status --global`. */
  global?: boolean;
}): React.ReactElement {
  // Toggled in place with `g`, so widening the view is one keystroke rather
  // than quitting and re-running with a flag.
  const [global, setGlobal] = useState(initialGlobal);
  // Resolved once: the tenant a directory maps to does not change while the
  // screen is open, and resolving it walks the filesystem.
  const [tenant] = useState(() => projectTenant(cwd, home));
  useInput((input) => { if (input === 'g') setGlobal((g) => !g); });
  const [up, setUp] = useState<boolean | undefined>(undefined);
  const [routes, setRoutes] = useState<RouteLine[] | undefined>(undefined);
  const [at, setAt] = useState<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const port = routerPorts(home).router;
  const palette = usePalette();

  useEffect(() => {
    let cancelled = false;

    const sample = async (): Promise<void> => {
      // Bounded: a router that accepts the connection and never answers would
      // otherwise hang this screen, which is the fault it exists to report.
      let alive = false;
      try {
        alive = await isSonataRouter(port, ((url: string, init?: RequestInit) =>
          fetch(url, { ...init, signal: AbortSignal.timeout(2000) })) as typeof fetch);
      } catch { alive = false; }
      if (cancelled) return;
      setUp(alive);
      try {
        // The router's own identity for this directory, not `project === cwd`.
        // The old compare failed from a subdirectory and a worktree, and it let
        // every UNATTRIBUTED row through too — which is why this board was
        // full of another context's passthrough traffic.
        const rows = scopeRows(
          readRows(home, Date.now() - 3_600_000),
          global ? { global: true } : { global: false, tenant },
        );
        setRoutes(recentRoutes(rows, 12));
      } catch {
        // An unreadable ledger is not a reason to show nothing: the router's
        // own state is still worth reporting, and an empty list says so below.
        setRoutes([]);
      }
      setAt(Date.now());
    };

    void sample();
    // Re-sampled rather than watched: the ledger is append-only files written
    // by another process, and a poll is the honest way to read them. The
    // interval is generous because this is a screen someone reads, not a
    // meter they stare at, and every tick costs an HTTP call and a file scan.
    const poll = setInterval(() => { void sample(); }, STATUS_POLL_MS);
    // The "as of" line has to keep ageing between samples, or a stalled
    // poller would show a timestamp frozen at the last success and read as
    // fresh. Ticking the clock separately makes a stall visible.
    const clock = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { cancelled = true; clearInterval(poll); clearInterval(clock); };
  }, [port, home, cwd, global, tenant]);

  const usable = usableWidth();
  const col = columns(usable);
  // Never wider than the painted page: `columns` floors at 40 cells and a
  // terminal can be narrower, and a rule that wraps takes the header with it.
  const ruleCells = Math.min(col.total, usable);
  const sc = statusColumns(usable);
  // Bounded by the terminal's HEIGHT as well as its width. A route costs one
  // line plus one per failed attempt, so a burst of fallbacks otherwise
  // scrolls this screen's own header away.
  const visible = routes === undefined
    ? []
    : routes.slice(0, routesThatFit(
      routes.map((r) => 1 + r.attempts.length),
      process.stdout.rows ?? 24,
      // What the screen spends on itself: the two headings, their rules, the
      // router line, two spacers and the footer — plus the two hint lines
      // when the router is down, and one held back for the "N more" line.
      // Counted exactly now that every line is guaranteed to be ONE line.
      9 + (up === false ? 2 : 0) + 1,
    ));
  const fresh = at === undefined ? 'sampling…' : `updated ${agoLabel(now - at)}`;

  /*
   * Every line below is ONE `<Text wrap="truncate-end">` with styled spans
   * nested inside it, never a row of sibling `<Text>`s in a `<Box>`.
   *
   * Siblings in a row Box are laid out by flexbox, and when their total runs
   * past the terminal each one shrinks and WRAPS inside its own cell — so one
   * over-long row becomes two or three lines, the list outgrows the screen,
   * and the header scrolls off the top. That is how this screen "did not
   * render" below a certain width, twice: the column budget was right for
   * wide terminals and its minimum sizes added up to more than a narrow one.
   *
   * A single Text truncates instead. The budget still decides what is worth
   * showing; this makes sure being wrong about it can cost the end of a line
   * and never the whole screen.
   */
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={palette.TEXT}>router</Text>
        <Text color={palette.MUTED}>{`   ${fresh}`}</Text>
      </Text>
      <Text color={palette.RULE}>{'─'.repeat(ruleCells)}</Text>
      <Text wrap="truncate-end" color={palette.TEXT}>
        <Text color={up === true ? palette.ACCENT : palette.MUTED}>
          {up === undefined ? STATE.unscored.mark : up ? STATE.lead.mark : STATE.cooled.mark}
        </Text>
        <Text color={palette.MUTED}>
          {up === undefined ? '  checking…' : up ? `  up on port ${port}` : `  not running on port ${port}`}
        </Text>
      </Text>
      {up === false && (
        // Two short lines rather than one long one: as a single sentence it
        // wrapped at 80 columns and orphaned the word "why." on a line of its
        // own, directly under a board whose whole grammar is "nothing wraps".
        <Box flexDirection="column">
          <Text wrap="truncate-end" color={palette.MID}>{'   start it with `sonata serve --daemon`'}</Text>
          <Text wrap="truncate-end" color={palette.MUTED}>{'   or run `sonata doctor` to find out why'}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        {/* Which project axis is on screen, always stated: the two views look
            identical row by row, and mistaking one for the other is the bug
            this scoping exists to fix. */}
        <Text wrap="truncate-end">
          <Text bold color={palette.TEXT}>routes, last hour</Text>
          <Text color={palette.MUTED}>{global ? '   every project' : '   this project'}</Text>
        </Text>
      </Box>
      <Text color={palette.RULE}>{'─'.repeat(ruleCells)}</Text>
      {routes === undefined && <Text color={palette.MUTED}>reading the ledger…</Text>}
      {routes !== undefined && routes.length === 0 && (
        // An empty screen is an invitation, not a void: say what would put
        // something here rather than printing "none".
        <Box flexDirection="column">
          {!global && tenant === undefined ? (
            <>
              <Text color={palette.MUTED}>No sonata.toml resolves here, so nothing is attributed to this project.</Text>
              <Text color={palette.MUTED}>Press g for every project's routes.</Text>
            </>
          ) : (
            <>
              <Text color={palette.MUTED}>
                {global ? 'Nothing routed in the last hour.' : 'Nothing routed from this project in the last hour.'}
              </Text>
              <Text color={palette.MUTED}>
                {global ? 'Dispatch a tier agent and it appears here.' : 'Press g for every project, or dispatch a tier agent.'}
              </Text>
            </>
          )}
        </Box>
      )}
      {visible.map((line, i) => {
        const failed = line.served === undefined;
        const mark = failed ? STATE.cooled : STATE.live;
        return (
          <Box key={`${line.alias}-${i}`} flexDirection="column">
            <Text wrap="truncate-end">
              {sc.time && (
                <Text color={palette.MUTED}>{`${localTime(line.ts).padEnd(8)} `}</Text>
              )}
              <Text color={failed ? palette.HIGH : palette.MUTED}>{`${String(line.status).padStart(3)} `}</Text>
              <Text color={palette.TEXT}>{fit(line.alias, sc.alias).padEnd(sc.alias)}</Text>
              <Text color={palette.MUTED}>{` ${mark.mark} `}</Text>
              <Text color={failed ? palette.MUTED : palette.TEXT}>
                {/* The effort level rides with the model it was sent to.
                    Two rows of one model at different levels are otherwise
                    indistinguishable, which is the case a reader checking a
                    tier is actually looking at. */}
                {fit(
                  `${line.served ?? 'no candidate served'}${line.effort !== undefined ? `@${line.effort}` : ''}`,
                  sc.served,
                ).padEnd(sc.served)}
              </Text>
              {sc.gateway && (
                <Text color={palette.MUTED}>{fit(line.gateway ?? '', 11).padEnd(12)}</Text>
              )}
              {sc.tokens && (
                <Text color={palette.MUTED}>{`${line.input} in / ${line.output} out`}</Text>
              )}
            </Text>
            {/* Failed attempts are why a dispatch died, so they are not a detail. */}
            {line.attempts.map((a) => (
              <Text key={a.key} wrap="truncate-end">
                <Text color={palette.MUTED}>{'      '}</Text>
                <Text color={palette.MUTED}>{STATE.cooled.mark} {a.key} </Text>
                <Text color={palette.HIGH}>{a.status}</Text>
              </Text>
            ))}
          </Box>
        );
      })}
      {routes !== undefined && visible.length < routes.length && (
        // Said plainly rather than silently truncated: a list that stops
        // without saying so reads as the whole list.
        <Text wrap="truncate-end" color={palette.MUTED}>{`… ${routes.length - visible.length} more, not shown`}</Text>
      )}
      <Box marginTop={1}>
        <Text wrap="truncate-end" color={palette.MUTED}>{`g ${global ? 'this project' : 'every project'}   esc back`}</Text>
      </Box>
    </Box>
  );
}
