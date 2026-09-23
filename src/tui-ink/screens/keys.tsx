import React from 'react';
import { Text } from 'ink';
import { keyReport } from '../../native/credentials.js';
import { STATE } from '../theme.js';
import { usePalette } from '../theme-context.js';
import { Message, Screen, count, fit, ruleWidth } from '../components/screen.js';
import { loadConfigForScreen } from './screen-config.js';
import { keyRows, gatewaysMissingKeys } from './key-rows.js';

/**
 * Show credential sources without exposing or editing secret values.
 *
 * Deliberately read-only. A key typed into a TUI is a key in a rendered
 * buffer, and `sonata auth add` already puts it straight into the store —
 * which is why the footer names that command rather than offering an editor.
 */
export function KeysScreen({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const palette = usePalette();
  const loaded = loadConfigForScreen(cwd, home);
  if (!loaded.ok) return <Message text={loaded.message} title="Keys" />;

  // Entries rather than names: an OAuth gateway has no bearer key and cannot
  // have one, so `keyRows` needs the auth kind to tell "authenticated by a
  // subscription" apart from "missing a credential".
  const entries = Object.entries(loaded.config.native?.gateways ?? {})
    .map(([gateway, gw]) => ({ gateway, auth: gw.auth }));
  const rows = keyRows(entries, keyReport(entries.map((e) => e.gateway), home));
  const missing = new Set(gatewaysMissingKeys(rows));
  const width = Math.max(...rows.map((row) => row.gateway.length), 7);
  const rest = Math.max(12, ruleWidth() - 4 - width - 2);

  return (
    <Screen
      title="Keys"
      note={missing.size === 0 ? `${count(rows.length, 'gateway')}, all credentialed` : `${missing.size} of ${rows.length} need a credential`}
      footer="esc back   q quit   ·   add one with `sonata auth add <gateway>`"
    >
      {rows.length === 0 && (
        <Text color={palette.MUTED}>No gateways configured, so there is nothing to authenticate.</Text>
      )}
      {rows.map((row) => {
        // A gateway with no credential cannot serve, so it is `cooled` rather
        // than `held`: held is a choice, this is a fault with a named fix.
        const none = missing.has(row.gateway);
        return (
          <Text key={row.gateway}>
            <Text color={none ? palette.HIGH : palette.MUTED}>{(none ? STATE.cooled.mark : STATE.live.mark).padEnd(4)}</Text>
            <Text color={none ? palette.MID : palette.TEXT}>{row.gateway.padEnd(width + 2)}</Text>
            <Text color={palette.MUTED}>{fit(row.source, rest)}</Text>
          </Text>
        );
      })}
    </Screen>
  );
}
