import React, { useRef, useState } from 'react';
import { join } from 'node:path';
import { Box, Text, useInput } from 'ink';
import { cmdSync } from '../../commands/sync.js';
import { cmdCatalogUpdate } from '../../commands/catalog.js';
import { cmdRoute } from '../../commands/route.js';
import { installLitellm } from '../../native/litellm-venv.js';
import { defaultInstallerDeps } from '../../commands/litellm.js';
import { actionRows, staleNames, summariseCatalog, summariseSync } from './action-rows.js';
import { Menu, moveCursor, type MenuItem } from '../components/menu.js';
import { Screen } from '../components/screen.js';
import { usePalette } from '../theme-context.js';

/**
 * The things this screen can do.
 *
 * A cursor rather than the letter keys it had (`s` sync, `c` catalog). The
 * same reason the overview menu changed: a mnemonic is fine once learnt and a
 * wall on first use, and here it was worse — two of the four rows are *not*
 * runnable, so the footer advertised four letters of which two did nothing.
 * A disabled row in a cursor menu is visibly unavailable and still says why.
 *
 * Every row runs, including the two that used to say "not from here". See
 * `action-rows.ts` for why that was stale: the shell now hosts `Setup`, which
 * already performs both.
 *
 * The long ones report progress rather than blocking silently, which is the
 * actual answer to "a multi-minute install looks like a hang" — a running
 * state, not a refusal.
 */
export function ActionsScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const packageRoot = new URL('../../..', import.meta.url).pathname;
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
    // One at a time: every action here writes to disk, and two installs
    // racing on the same venv is not a state worth being able to reach.
    if (running !== undefined) return;
    if (running !== undefined) return;  // one at a time; these write to disk
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
      return;
    }
    if (key === 'l') {
      const current = ++requestId.current;
      // Named as minutes, because it is: the install fetches a pinned venv.
      // Silence here is what made this action feel like a hang, so the screen
      // says what is happening and roughly how long it lasts.
      setRunning('installing LiteLLM — this takes a few minutes…');
      setMessage(undefined);
      void installLitellm(home, defaultInstallerDeps).then(() => {
        if (current !== requestId.current) return;
        setMessage('LiteLLM installed');
        setRunning(undefined);
      }).catch((error: unknown) => {
        if (current !== requestId.current) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setRunning(undefined);
      });
      return;
    }
    if (key === 'r') {
      const current = ++requestId.current;
      setRunning('installing routing hooks…');
      setMessage(undefined);
      // Project scope, matching what `sonata init` defaults to. Global is a
      // decision about every repository on the machine and belongs to a
      // screen that can say so, not to a single keystroke here.
      void cmdRoute('auto', { cwd, home, packageRoot, scope: 'project' }).then(() => {
        if (current !== requestId.current) return;
        setMessage('routing on for this project — new `claude` sessions route through sonata');
        setRunning(undefined);
      }).catch((error: unknown) => {
        if (current !== requestId.current) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setRunning(undefined);
      });
      return;
    }
    if (key === 'l') {
      const current = ++requestId.current;
      // Named in minutes because it takes minutes. Silence is what made this
      // read as a hang, and the fix is to say what is happening, not to
      // refuse to do it.
      setRunning('installing LiteLLM — this takes a few minutes…');
      setMessage(undefined);
      void installLitellm(home, defaultInstallerDeps).then(() => {
        if (current !== requestId.current) return;
        setMessage('LiteLLM installed');
        setRunning(undefined);
      }).catch((error: unknown) => {
        if (current !== requestId.current) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setRunning(undefined);
      });
      return;
    }
    if (key === 'r') {
      const current = ++requestId.current;
      setRunning('installing routing hooks…');
      setMessage(undefined);
      // Project scope, matching what `sonata init` defaults to. Global is a
      // decision about every repository on the machine, and that belongs to a
      // screen that can say so rather than to one keystroke here.
      void cmdRoute('auto', { cwd, home, packageRoot, scope: 'project' }).then(() => {
        if (current !== requestId.current) return;
        setMessage('routing on for this project — new `claude` sessions reach sonata');
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
        <Box marginTop={1}><Text color={palette.TEXT}>{message}</Text></Box>
      )}
    </Screen>
  );
}
