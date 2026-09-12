/**
 * The `sonata agents` browser: every tier agent, what it runs on, and a
 * ranking editor one keystroke away.
 *
 * The list is role × tier rather than agent-shaped, even though two identical
 * lists generate a single collapsed agent file. Editing is per-list — a
 * collapsed pair has to be openable separately or there is no way to make the
 * tiers differ again from here — so the rows are the things being edited, and
 * a row whose pair collapses says which file it actually produces. That note
 * comes from `tiersCollapse`, the same predicate `sync` writes by, so the
 * screen cannot promise a file `sync` will not write.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { RankedSelect } from './components/ranked-select.js';
import { TIER_NAMES, tiersCollapse, type SonataConfig } from '../config.js';
import { EXTENDED_CONTEXT_SUFFIX, tierQualifiesForExtendedContext } from '../extended-context.js';

export type Tiers = Record<string, { simple: string[]; complex: string[] }>;

export interface TierRow {
  role: string;
  tier: 'simple' | 'complex';
  keys: string[];
  /** The agent file this row ends up in — collapsed pairs share one. */
  agent: string;
  extendedContext: boolean;
}

/** One row per editable list, with the agent file each will land in. */
export function tierRows(config: SonataConfig, tiers: Tiers): TierRow[] {
  return Object.entries(tiers).flatMap(([role, lists]) => {
    const collapsed = tiersCollapse(lists);
    return TIER_NAMES.map((tier) => ({
      role,
      tier,
      keys: lists[tier],
      agent: collapsed ? role : `${role}-${tier}`,
      extendedContext: collapsed
        ? tierQualifiesForExtendedContext(config, lists.simple)
          && tierQualifiesForExtendedContext(config, lists.complex)
        : tierQualifiesForExtendedContext(config, lists[tier]),
    }));
  });
}

export interface AgentsAppProps {
  config: SonataConfig;
  initialTiers: Tiers;
  /** Every key that may be ranked, with a human label. */
  items: Array<{ value: string; label: string }>;
  /** `undefined` means the user quit without saving. */
  onDone: (tiers: Tiers | undefined) => void;
}

export function AgentsApp(props: AgentsAppProps): React.ReactElement {
  const { config, items, onDone } = props;
  const [tiers, setTiers] = useState<Tiers>(props.initialTiers);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<TierRow | undefined>(undefined);

  const rows = tierRows(config, tiers);
  const dirty = JSON.stringify(tiers) !== JSON.stringify(props.initialTiers);

  useInput((input, key) => {
    if (editing !== undefined) return;
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
    else if (key.return) setEditing(rows[cursor]);
    else if (input === 'w') onDone(dirty ? tiers : undefined);
    else if (key.escape || input === 'q') onDone(undefined);
  }, { isActive: editing === undefined });

  if (editing !== undefined) {
    return <RankedSelect
      key={`${editing.role}-${editing.tier}`}
      title={`${editing.role}: ${editing.tier} models — order is the fallback order`}
      items={items}
      initialRanked={editing.keys}
      footer="enter confirms · ← back without changing this list"
      onSubmit={(ranked) => {
        setTiers((current) => ({
          ...current,
          [editing.role]: { ...current[editing.role], [editing.tier]: ranked },
        }));
        setEditing(undefined);
      }}
      onBack={() => setEditing(undefined)}
      onCancel={() => setEditing(undefined)}
    />;
  }

  return (
    <Box flexDirection="column">
      <Text bold>sonata agents</Text>
      <Text dimColor>{'↑↓ move · enter re-rank · w write · q quit without saving'}</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row, index) => (
          <Box key={`${row.role}-${row.tier}`} flexDirection="column">
            <Text color={index === cursor ? 'cyan' : undefined}>
              {index === cursor ? '❯ ' : '  '}
              {`${row.role}-${row.tier}`.padEnd(18)}
              {row.agent !== `${row.role}-${row.tier}` ? `→ ${row.agent}.md  ` : ''}
              {row.extendedContext ? EXTENDED_CONTEXT_SUFFIX : ''}
            </Text>
            <Text dimColor>
              {'      '}
              {row.keys.length === 0 ? '(empty — every dispatch falls through to sonata dispatch)' : row.keys.join(' → ')}
            </Text>
          </Box>
        ))}
      </Box>
      {dirty ? <Text color="yellow">{'\n  unsaved changes — w writes them, q discards'}</Text> : null}
    </Box>
  );
}
