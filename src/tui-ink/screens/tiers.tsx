import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { loadAaCatalog } from '../../catalog.js';
import { loadModelsDev } from '../../modelsdev.js';
import { editorCandidates, itemLabel, writeTiers } from '../../commands/agents.js';
import { AgentsApp } from '../agents-app.js';
import { loadConfigForScreen } from './screen-config.js';

export function TiersScreen({ cwd, home, onBack }: { cwd: string; home: string; onBack: () => void }): React.ReactElement {
  const loaded = loadConfigForScreen(cwd, home);
  const [error, setError] = useState<string>();
  if (!loaded.ok) return <Box flexDirection="column"><Text color="yellow">{loaded.message}</Text><Box marginTop={1}><Text dimColor>esc back</Text></Box></Box>;
  const { config } = loaded;
  const aa = loadAaCatalog(home);
  const modelsDev = loadModelsDev(home);
  const items = editorCandidates(config, aa, modelsDev).map((candidate) => ({ value: candidate, label: itemLabel(config, candidate, aa, modelsDev) }));
  if (error !== undefined) return <Box flexDirection="column"><Text color="yellow">{error}</Text><Box marginTop={1}><Text dimColor>esc back</Text></Box></Box>;
  return <AgentsApp config={config} initialTiers={config.tiers ?? {}} items={items} onDone={(tiers) => {
    if (tiers === undefined) { onBack(); return; }
    try { writeTiers({ cwd, home }, tiers, config.tiers ?? {}); onBack(); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }} />;
}
