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
import { Box, Text, useInput, useWindowSize } from 'ink';
import { RankedSelect } from './components/ranked-select.js';
import { TIER_NAMES, tiersCollapse, type SonataConfig, type TierLists } from '../config.js';
import { EXTENDED_CONTEXT_SUFFIX, tierQualifiesForExtendedContext } from '../extended-context.js';
import { usePalette } from './theme-context.js';
import { fit, ruleWidth } from './components/screen.js';
import type { RankedSelectItem } from './components/ranked-select.js';

export type Tiers = Record<string, TierLists>;

export interface TierRow {
  role: string;
  tier: 'simple' | 'normal' | 'complex';
  keys: string[];
  /** The agent file this row ends up in — collapsed pairs share one. */
  agent: string;
  extendedContext: boolean;
}

/** One row per editable list, with the agent file each will land in. */
export function tierRows(config: SonataConfig, tiers: Tiers): TierRow[] {
  return Object.entries(tiers).flatMap(([role, lists]) => {
    const collapsed = tiersCollapse(lists);
    return TIER_NAMES.flatMap((tier) => {
      const keys = lists[tier];
      if (keys === undefined) return [];
      return [{
        role,
        tier,
        keys,
        agent: collapsed ? role : `${role}-${tier}`,
        extendedContext: collapsed
          ? tierQualifiesForExtendedContext(config, lists.simple)
            && (lists.normal === undefined || tierQualifiesForExtendedContext(config, lists.normal))
            && tierQualifiesForExtendedContext(config, lists.complex)
          : tierQualifiesForExtendedContext(config, keys),
      }];
    });
  });
}

export interface AgentsAppProps {
  config: SonataConfig;
  initialTiers: Tiers;
  /** Every key that may be ranked, with a human label. */
  items: Array<{ value: string; label: string }>;
  /**
   * A candidate's measurements, for the tier currently being edited.
   *
   * A function rather than a field on `items`, because the metric depends on
   * the tier: `complex` ranks on reasoning and the value tiers on throughput,
   * so a number attached once at construction would explain the ordering on
   * two screens out of three. `init` already computes it per tier screen for
   * exactly this reason.
   *
   * Optional, so a caller with no catalog still opens the editor. Absent, the
   * board renders every row through `RankedSelect`'s unscored branch — dashed
   * track, `—` cost, "unranked" — which is right for a model the catalog
   * cannot price and was wrong for *all* of them, which is what this repairs.
   * `sonata agents` is the surface PRODUCT.md rates frequent, and it was
   * drawing the checkbox list this redesign replaced while `init`, run about
   * three times ever, drew the board.
   */
  factsFor?: (candidate: string, tier: keyof TierLists) => RankedSelectItem<string>['facts'];
  /** `undefined` means the user quit without saving. */
  onDone: (tiers: Tiers | undefined) => void;
}

/**
 * What the board's bar measures for a tier, in the reader's words.
 *
 * `complex` ranks on reasoning and the value tiers on tool-driving
 * throughput, and the bar always draws whichever its tier ranks by so it
 * explains the order it appears in. Naming it is what stops the column being
 * three unlabelled quantities in a row — asked directly, "what does the bar
 * mean?", which is the question a legend exists to prevent.
 */
export function metricLabel(tier: keyof TierLists): string {
  return tier === 'complex' ? 'intelligence' : 'agentic';
}

export function AgentsApp(props: AgentsAppProps): React.ReactElement {
  const { config, items, factsFor, onDone } = props;
  const palette = usePalette();
  // Re-rendered on resize so the list and the ranking board recompute their
  // widths; see `ConfigTui`, which does the same for the shell. This is the
  // root when `sonata agents` renders on its own.
  useWindowSize();
  const [tiers, setTiers] = useState<Tiers>(props.initialTiers);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<TierRow | undefined>(undefined);

  const rows = tierRows(config, tiers);
  const selected = rows[cursor];
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
      metric={metricLabel(editing.tier)}
      items={factsFor === undefined
        ? items
        : items.map((item) => ({ ...item, facts: factsFor(item.value, editing.tier) }))}
      initialRanked={editing.keys}
      footer="enter confirm   ← back without changing this list"
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
      <Box>
        <Text bold color={palette.TEXT}>Tiers</Text>
        <Text color={palette.MUTED}>
          {`   ${rows.length} ranked lists${dirty ? '   ·   unsaved changes' : ''}`}
        </Text>
      </Box>
      <Text color={palette.RULE}>{'\u2500'.repeat(ruleWidth())}</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row, index) => (
          <Box key={`${row.role}-${row.tier}`} flexDirection="column">
            {/* Selection three ways, as `menu.tsx` draws it: an accent edge,
                a band, and full-strength text against muted neighbours. The
                `❯` + cyan this replaced carried it on colour alone, which is
                nothing in a two-colour terminal. */}
            <Text color={palette.TEXT}>
              <Text color={palette.ACCENT}>{index === cursor ? '\u258c' : ' '}</Text>
              <Text
                backgroundColor={index === cursor ? palette.BAND : undefined}
                color={index === cursor ? palette.TEXT : palette.MUTED}
                bold={index === cursor}
              >
              {' '}
              {`${row.role}-${row.tier}`.padEnd(18)}
              {row.agent !== `${row.role}-${row.tier}` ? `→ ${row.agent}.md  ` : ''}
              {row.extendedContext ? EXTENDED_CONTEXT_SUFFIX : ''}
              </Text>
            </Text>
          </Box>
        ))}
      </Box>
      {/* The chain belongs to the selected row only.

          Drawn on every row it wrapped to three lines each — twelve rows of
          role × tier became forty lines, so the header and the cursor
          scrolled off the top and the screen could not say what was selected.
          A wrapped row stops being a row, which is the rule `theme.ts`
          states, and this screen broke it worst.
          One line per row and the detail under the cursor keeps the whole
          list on one screen, which is what makes it a list. */}
      {selected !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.MUTED}>
            {selected.keys.length === 0
              ? 'empty — every dispatch falls through to `sonata dispatch`'
              : fit(selected.keys.join(' → '), ruleWidth())}
          </Text>
          {selected.keys.length > 0 && (
            <Text color={palette.MUTED}>{`${selected.keys.length} ranked, tried in this order`}</Text>
          )}
        </Box>
      )}
      {/* `MID`, not a hardcoded yellow: yellow on the light palette is the
          vanishing text `theme.ts` exists to prevent, and it does not move
          with the toggle. */}
      {dirty ? <Text color={palette.MID}>{'\n  unsaved changes — w writes them, q discards'}</Text> : null}
      <Box marginTop={1}>
        <Text color={palette.MUTED}>{'\u2191\u2193 move   enter re-rank   w write   q quit without saving'}</Text>
      </Box>
    </Box>
  );
}
