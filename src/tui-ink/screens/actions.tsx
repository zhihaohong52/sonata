import React, { useRef, useState } from 'react';
import { join } from 'node:path';
import { Box, Text, useInput } from 'ink';
import { cmdSync } from '../../commands/sync.js';
import { cmdCatalogUpdate } from '../../commands/catalog.js';
import { actionRows, staleNames, summariseSync } from './action-rows.js';

export function ActionsScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const [message, setMessage] = useState<string>();
  const [updating, setUpdating] = useState(false);
  const requestId = useRef(0);
  useInput((input) => {
    if (input === 's') {
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
    }
    if (input === 'c') {
      const current = ++requestId.current;
      setUpdating(true);
      void cmdCatalogUpdate(home).then((result) => {
        if (current !== requestId.current) return;
        setMessage(JSON.stringify(result));
        setUpdating(false);
      }).catch((error: unknown) => {
        if (current !== requestId.current) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setUpdating(false);
      });
    }
  });
  return <Box flexDirection="column">
    <Text bold>Actions</Text>
    <Box flexDirection="column" marginTop={1}>{actionRows().map((row) => <Text key={row.key}>{row.key}  {row.runnable ? row.label : row.note}</Text>)}</Box>
    {updating ? <Text>updating…</Text> : message === undefined ? null : <Text>{message}</Text>}
    <Box marginTop={1}><Text dimColor>esc back</Text></Box>
  </Box>;
}
