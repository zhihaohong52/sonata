import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { loadAaCatalog } from '../../catalog.js';
import { loadModelsDev } from '../../modelsdev.js';
import { editorCandidates, itemLabel, writeTiers } from '../../commands/agents.js';
import { AgentsApp } from '../agents-app.js';
import { loadConfigForScreen } from './screen-config.js';

/** The error state and the no-config state render the same shape. */
function Message({ text }: { text: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="yellow">{text}</Text>
      <Box marginTop={1}><Text dimColor>esc back</Text></Box>
    </Box>
  );
}

/**
 * Re-rank a role's tiers, from inside the TUI.
 *
 * Deliberately a wrapper rather than an editor: `sonata agents` already is one,
 * and `AgentsApp` is the component it drives. What matters is that the **write**
 * goes through `writeTiers` and nothing else. That function carries protections
 * this repository paid for — a byte-preserving no-op so confirming an unchanged
 * ranking cannot rewrite the file, `replaceTiersBlock` so every byte outside
 * `[tiers]` survives, a parse-back before the write so a config that will not
 * load never replaces a working one, `assertEffortsPinned`, and the stale-agent
 * report. Writing the file here instead would be a second copy of all of that,
 * which is exactly how `tiersCollapse` ended up rebuilt at three call sites with
 * one of them wrong.
 *
 * A refused write is rendered rather than thrown. `assertEffortsPinned` rejects
 * a ranking that pins no effort level, and that refusal is the feature — the
 * user needs to read it and pick again, not lose the TUI.
 */
export function TiersScreen(
  { cwd, home, onBack }: { cwd: string; home: string; onBack: () => void },
): React.ReactElement {
  const loaded = loadConfigForScreen(cwd, home);
  const [error, setError] = useState<string>();

  if (!loaded.ok) return <Message text={loaded.message} />;
  const { config } = loaded;
  const aa = loadAaCatalog(home);
  const modelsDev = loadModelsDev(home);
  const items = editorCandidates(config, aa, modelsDev).map((candidate) => ({
    value: candidate,
    label: itemLabel(config, candidate, aa, modelsDev),
  }));

  return (
    <>
      {error !== undefined ? <Message text={error} /> : null}
      <AgentsApp
      config={config}
      initialTiers={config.tiers ?? {}}
      items={items}
      onDone={(tiers) => {
        if (tiers === undefined) { onBack(); return; }
        try {
          writeTiers({ cwd, home }, tiers, config.tiers ?? {});
          onBack();
        } catch (cause: unknown) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }}
      />
    </>
  );
}
