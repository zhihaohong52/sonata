import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { cmdUsage, coveredLabel, spentLabel, type UsageDimension, type UsageReport } from '../../commands/usage.js';
import { usableWidth } from '../theme.js';
import { fit } from '../components/screen.js';
import { usePalette } from '../theme-context.js';
import { agoLabel } from './status-poll.js';
import {
  bucketsThatFit, compactCount, nextDimension, nextWindow, usageColumns, USAGE_CELL, USAGE_POLL_MS, windowLabel,
} from './usage-view.js';

const money = (usd: number): string => `$${usd.toFixed(usd >= 100 ? 2 : 4)}`;

/**
 * What the native path has spent, as a board.
 *
 * The same report `sonata usage` prints, with its three axes one key away
 * instead of one re-run away: `d` changes the breakdown, `w` the window, `g`
 * the project. The honesty rules of the printed report carry over unchanged —
 * unpriced volume and covered work are stated beside the total, never folded
 * into it, and the native-only caveat is always on screen.
 *
 * Defaults to every project, like `sonata usage` itself; `--project .` (or
 * `g`) narrows it to the project this directory resolves to.
 */
export function UsageScreen({ cwd, home, by: initialBy = 'model', since: initialSince = '7d', project: initialProject = false }: {
  cwd: string;
  home: string;
  by?: UsageDimension;
  since?: string;
  /** Start scoped to this project rather than every project; `sonata usage --project .`. */
  project?: boolean;
}): React.ReactElement {
  const [by, setBy] = useState<UsageDimension>(initialBy);
  const [since, setSince] = useState(initialSince);
  const [project, setProject] = useState(initialProject);
  const [report, setReport] = useState<UsageReport | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [at, setAt] = useState<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const palette = usePalette();

  useInput((input) => {
    if (input === 'd') setBy((b) => nextDimension(b));
    if (input === 'w') setSince((s) => nextWindow(s));
    if (input === 'g') setProject((p) => !p);
  });

  useEffect(() => {
    let cancelled = false;
    // A changed axis is a different report: clear the old one so the board
    // never shows last view's buckets under this view's heading.
    setReport(undefined);
    const sample = async (): Promise<void> => {
      try {
        const next = await cmdUsage({ home, since, by, project: project ? cwd : undefined, json: false });
        if (cancelled) return;
        setReport(next);
        setFailure(undefined);
      } catch (error) {
        if (cancelled) return;
        setFailure(error instanceof Error ? error.message : String(error));
      }
      setAt(Date.now());
    };
    void sample();
    const poll = setInterval(() => { void sample(); }, USAGE_POLL_MS);
    // Ticks separately so a stalled poll shows as an ageing "updated" line.
    const clock = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { cancelled = true; clearInterval(poll); clearInterval(clock); };
  }, [home, cwd, by, since, project]);

  const usable = usableWidth();
  const anyCovered = report?.buckets.some((b) => b.coveredRequests > 0) ?? false;
  const col = usageColumns(usable, anyCovered);
  const fresh = at === undefined ? 'reading…' : `updated ${agoLabel(now - at)}`;

  // Footnotes under the total, each one line. Counted before the rows are
  // cut, since they are what keeps the total honest and must not scroll off.
  const notes: Array<{ text: string; tone: 'MID' | 'MUTED' }> = [];
  if (report !== undefined) {
    if (report.covered.requests > 0) {
      notes.push({ text: `covered   ${money(report.covered.totalUsd)} of subscription work, valued at list, not billed`, tone: 'MUTED' });
    }
    if (report.unpriced.requests > 0) {
      notes.push({
        text: `unpriced  ${report.unpriced.requests} requests, ${compactCount(report.unpriced.input)} in, ${compactCount(report.unpriced.output)} out — not in the total`,
        tone: 'MID',
      });
    }
    if (report.noPromptTokens.requests > 0) {
      notes.push({ text: `${report.noPromptTokens.requests} requests reported no prompt tokens and are priced on output only`, tone: 'MID' });
    }
    if (report.failedAttempts.length > 0) {
      const worst = report.failedAttempts.slice(0, 3).map((a) => `${a.key} ${a.count}× (${a.statuses.join('/')})`).join(', ');
      notes.push({ text: `fell past ${worst}`, tone: 'MID' });
    }
  }
  // Heading, rule, column header, rule, total, notes, caveat, spacer, keys.
  const chrome = 4 + 1 + notes.length + 1 + 2 + 1;
  const buckets = report?.buckets ?? [];
  const shown = buckets.slice(0, bucketsThatFit(buckets.length, process.stdout.rows ?? 24, chrome));

  const header = [
    col.requests ? 'req'.padStart(USAGE_CELL.requests) : '',
    col.tokens ? 'in / out'.padStart(USAGE_CELL.tokens) : '',
    'spent'.padStart(USAGE_CELL.spent),
    col.covered ? 'covered'.padStart(USAGE_CELL.covered) : '',
  ].join('');

  // Every line is ONE truncating Text, as on the status screen: sibling Texts
  // in a row wrap inside their own cells, and a wrapped row pushes the
  // heading off the top.
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={palette.TEXT}>usage</Text>
        <Text color={palette.MUTED}>{`   ${windowLabel(since)}   ${project ? 'this project' : 'every project'}   by ${by}   ${fresh}`}</Text>
      </Text>
      <Text color={palette.RULE}>{'─'.repeat(usable)}</Text>
      <Text wrap="truncate-end" color={palette.MUTED}>{`${''.padEnd(col.label)}${header}`}</Text>

      {failure !== undefined && (
        <Text wrap="truncate-end" color={palette.HIGH}>{`could not read the ledger: ${failure}`}</Text>
      )}
      {report === undefined && failure === undefined && <Text color={palette.MUTED}>reading the ledger…</Text>}
      {report !== undefined && buckets.length === 0 && (
        <Box flexDirection="column">
          <Text wrap="truncate-end" color={palette.MUTED}>
            {project ? `Nothing routed from this project in the ${windowLabel(since)}.` : `Nothing routed in the ${windowLabel(since)}.`}
          </Text>
          <Text wrap="truncate-end" color={palette.MUTED}>
            {project ? 'Press g for every project, or w for a longer window.' : 'Press w for a longer window, or dispatch a tier agent.'}
          </Text>
        </Box>
      )}
      {shown.map((bucket) => (
        <Text key={bucket.label} wrap="truncate-end">
          <Text color={palette.TEXT}>{fit(bucket.label, col.label - 1).padEnd(col.label)}</Text>
          {col.requests && <Text color={palette.MUTED}>{String(bucket.requests).padStart(USAGE_CELL.requests)}</Text>}
          {col.tokens && (
            <Text color={palette.MUTED}>
              {`${compactCount(bucket.input)} / ${compactCount(bucket.output)}`.padStart(USAGE_CELL.tokens)}
            </Text>
          )}
          <Text color={bucket.costUsd > 0 ? palette.TEXT : palette.MUTED}>{spentLabel(bucket, money).padStart(USAGE_CELL.spent)}</Text>
          {col.covered && <Text color={palette.MUTED}>{coveredLabel(bucket, money).padStart(USAGE_CELL.covered)}</Text>}
        </Text>
      ))}
      {shown.length < buckets.length && (
        <Text wrap="truncate-end" color={palette.MUTED}>{`… ${buckets.length - shown.length} more, not shown`}</Text>
      )}

      <Text color={palette.RULE}>{'─'.repeat(usable)}</Text>
      <Text wrap="truncate-end">
        <Text bold color={palette.TEXT}>priced total</Text>
        <Text color={palette.ACCENT}>{report === undefined ? '' : `   ${money(report.pricedTotalUsd)}`}</Text>
      </Text>
      {notes.map((note) => (
        <Text key={note.text} wrap="truncate-end" color={palette[note.tone]}>{note.text}</Text>
      ))}
      <Text wrap="truncate-end" color={palette.MUTED}>dispatch runs counted when they finish — `d` to lane splits them out</Text>
      <Box marginTop={1}>
        <Text wrap="truncate-end" color={palette.MUTED}>
          {`d by ${nextDimension(by)}   w ${windowLabel(nextWindow(since)).replace('last ', '')}   g ${project ? 'every project' : 'this project'}   esc back   q quit`}
        </Text>
      </Box>
    </Box>
  );
}
