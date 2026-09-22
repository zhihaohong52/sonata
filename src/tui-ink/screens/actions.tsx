import React, { useRef, useState } from 'react';
import { join } from 'node:path';
import { Box, Text, useInput } from 'ink';
import { cmdSync } from '../../commands/sync.js';
import { cmdCatalogUpdate } from '../../commands/catalog.js';
import { actionRows, staleNames, summariseCatalog, summariseSync } from './action-rows.js';
import { Menu, moveCursor, type MenuItem } from '../components/menu.js';
import { Screen } from '../components/screen.js';
import { usePalette } from '../theme-context.js';

/**
 * The things this screen can do, and the two it deliberately cannot.
 *
 * A cursor rather than the letter keys it had (`s` sync, `c` catalog). The
 * same reason the overview menu changed: a mnemonic is fine once learnt and a
 * wall on first use, and here it was worse — two of the four rows are *not*
 * runnable, so the footer advertised four letters of which two did nothing.
 * A disabled row in a cursor menu is visibly unavailable and still says why.
 *
 * Those two stay out on purpose. `litellm install` takes minutes with no
 * output, which inside a TUI is indistinguishable from a hang; `route auto`
 * edits Claude Code's own settings, which this screen does not own. Both name
 * the command to run instead rather than being hidden — a capability absent
 * with no explanation reads as a missing feature.
 */
export function ActionsScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const [message, setMessage] = useState<string>();
  const [running, setRunning] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const requestId = useRef(0);
  const palette = usePalette();
  const rows = actionRows();

  const items: ReadonlyArray<MenuItem<string>> = rows.map((row) => ({
    value: row.key,
    label: row.label,
    note: row.runnable ? undefined : 'not from here',
    disabled: !row.runnable,
  }));

  const run = (key: string): void => {
    const row = rows.find((r) => r.key === key);
    if (row === undefined || !row.runnable) return;
    if (key === 's') {
      setRunning(undefined);
      try {
        const result = cmdSync({ cwd, agentsDir: join(cwd, '.claude', 'agents'), home });
        const names = staleNames(result);
        // Named, not just counted: sonata does not delete a stale agent, and
        // Claude Code keeps offering it as a subagent type whose alias no
        // longer resolves, so a dispatch to it fails rather than falling back.
        setMessage(names.length === 0
          ? summariseSync(result)
          : `${summariseSync(result)}\n  stale: ${names.join(', ')}`);
      }
      catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (key === 'c') {
      const current = ++requestId.current;
      setRunning('fetching rankings and prices…');
      setMessage(undefined);
      void cmdCatalogUpdate(home).then((result) => {
        if (current !== requestId.current) return;
        setMessage(summariseCatalog(result));
        setRunning(undefined);
      }).catch((error: unknown) => {
        if (current !== requestId.current) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setRunning(undefined);
      });
    }
  };

  useInput((input, key) => {
    if (key.upArrow) { setCursor((c) => moveCursor(c, items.length, 'up')); return; }
    if (key.downArrow) { setCursor((c) => moveCursor(c, items.length, 'down')); return; }
    if (key.return) { run(items[cursor]!.value); return; }
    // The letters still work, as on the overview: they were the only way in
    // before this screen had a cursor, and removing a working shortcut to add
    // one would be a downgrade for anyone who already learnt it.
    if (input !== '') run(input);
  });

  const selected = rows[cursor];

  return (
    <Screen title="Actions" footer="↑↓ move   enter run   esc back">
      <Menu items={items} cursor={cursor} />
      {/* The note explains the *selected* row rather than every row at once:
          four permanent explanations is a paragraph the reader stops seeing,
          where one that changes under the cursor is read every time. */}
      {selected !== undefined && (
        <Box marginTop={1}><Text color={palette.MUTED}>{selected.note}</Text></Box>
      )}
      {running !== undefined && <Box marginTop={1}><Text color={palette.ACCENT}>{running}</Text></Box>}
      {running === undefined && message !== undefined && (
        <Box marginTop={1}><Text>{message}</Text></Box>
      )}
    </Screen>
  );
}
