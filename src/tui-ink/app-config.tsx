import React, { useEffect, useState } from 'react';
import { homedir } from 'node:os';
import { Box, Text, render, useApp, useInput } from 'ink';
import { cmdDoctor, type Check } from '../commands/doctor.js';
import { nextStep, type Step } from './steps.js';
import { OverviewScreen } from './screens/overview.js';
import { BudgetScreen } from './screens/budget.js';
import { ModelsScreen } from './screens/models.js';
import { ProvidersScreen } from './screens/providers.js';
import { TiersScreen } from './screens/tiers.js';
import { KeysScreen } from './screens/keys.js';
import { ActionsScreen } from './screens/actions.js';
import { StatusScreen } from './screens/status.js';
import { InitScreen } from './screens/init.js';
import { Menu, moveCursor, type MenuItem } from './components/menu.js';
import { Ground, ThemeProvider, useTheme } from './theme-context.js';

/**
 * The menu, in the order a reader needs it: what is happening, then what is
 * configured, then what can be done to it.
 *
 * Setup sits last rather than first despite being what a new user needs, for
 * the reason it is `opens`-marked: it rewrites `sonata.toml` whole, and a
 * destructive row under the cursor's resting position is one stray enter away
 * from running. Someone who has never run it reaches it from the overview's
 * warning, which names it.
 */
const MENU: ReadonlyArray<MenuItem<Step>> = [
  { value: 'status', label: 'Status' },
  { value: 'models', label: 'Models', opens: true },
  { value: 'providers', label: 'Providers', opens: true },
  { value: 'tiers', label: 'Tiers', opens: true },
  { value: 'keys', label: 'Keys', opens: true },
  { value: 'budget', label: 'Budget', opens: true },
  { value: 'actions', label: 'Actions', opens: true },
  { value: 'init', label: 'Setup', opens: true },
];

/**
 * The config TUI.
 *
 * A flat step machine rather than a router: the smallest thing that works at
 * this size, and it keeps navigation in one pure function.
 *
 * The app owns its whole lifetime and never unmounts to hand off to a
 * `src/tui.ts` prompt. Ink *unrefs* stdin on unmount, so a prompt waiting on a
 * keystroke is not work node knows about and the process exits 0 mid-prompt —
 * with no error, because there is no error. That is what once made every
 * prompt after the wizard die instantly. Every confirmation is a screen.
 */
function ConfigTui({ cwd, home, start }: { cwd: string; home: string; start?: Step }): React.ReactElement {
  const { exit } = useApp();
  // `checking` always runs first: every screen is read against a machine the
  // health check has already described, and a deep link that skipped it would
  // open on stale or absent state. `start` is where boot lands, not a bypass.
  const [step, setStep] = useState<Step>('checking');
  const [checks, setChecks] = useState<Check[]>([]);
  const [cursor, setCursor] = useState(0);
  const { toggle, name: themeName, palette } = useTheme();

  useEffect(() => {
    if (step !== 'checking') return;
    let cancelled = false;
    cmdDoctor({ cwd, home })
      .then((result) => {
        if (cancelled) return;
        setChecks(result.checks);
        setStep(start ?? 'overview');
      })
      .catch(() => {
        // A machine doctor cannot describe is still one the TUI must open on,
        // so an empty result routes to an overview that says "no checks ran"
        // rather than leaving a spinner running forever.
        if (cancelled) return;
        setChecks([]);
        setStep(start ?? 'overview');
      });
    return () => { cancelled = true; };
  }, [step, cwd, home, start]);

  useInput((input, key) => {
    // Setup draws its own screens and owns every key while it runs — including
    // escape, which the branch below would otherwise read as "go back" and use
    // to abandon a half-finished init, leaving `cmdInit` suspended on a
    // promise nothing will ever resolve. `^t` stays live because a theme that
    // cannot be corrected on the longest screen in the app is the one place
    // the correction is most needed.
    if (step === 'init') {
      if (key.ctrl && input === 't') toggle();
      return;
    }
    // Ctrl-T anywhere: the detection in `resolveThemeName` is a guess most
    // terminals give it no evidence for, so the correction has to be one
    // keystroke away from wherever the reader noticed it was wrong.
    if (key.ctrl && input === 't') { toggle(); return; }
    if (step === 'checking') return;

    if (step === 'overview') {
      if (input === 'q' || key.escape) { exit(); return; }
      if (key.upArrow) { setCursor((c) => moveCursor(c, MENU.length, 'up')); return; }
      if (key.downArrow) { setCursor((c) => moveCursor(c, MENU.length, 'down')); return; }
      if (key.return) { setStep(MENU[cursor]!.value); return; }
      // The letter keys still work. They were the only way in before this
      // screen had a cursor, they are in muscle memory and in the docs, and
      // keeping them costs one line — removing a working shortcut to add a
      // cursor would be a downgrade for everyone who already learnt it.
      setStep((current) => nextStep(current, input));
      return;
    }
    if (key.escape) { setStep('overview'); return; }
    setStep((current) => nextStep(current, input));
  });

  if (step === 'checking') return <Text color={palette.TEXT}>checking…</Text>;
  if (step === 'budget') return <BudgetScreen cwd={cwd} home={home} />;
  if (step === 'models') return <ModelsScreen cwd={cwd} home={home} />;
  if (step === 'providers') return <ProvidersScreen cwd={cwd} home={home} />;
  if (step === 'tiers') return <TiersScreen cwd={cwd} home={home} onBack={() => setStep('overview')} />;
  if (step === 'keys') return <KeysScreen cwd={cwd} home={home} />;
  if (step === 'actions') return <ActionsScreen cwd={cwd} home={home} />;
  if (step === 'status') return <StatusScreen cwd={cwd} home={home} />;
  // Back to `checking`, not `overview`: init changes the machine this whole
  // app is drawn against, and the tier-routing warning that may have been the
  // reason for running it is answered by re-running doctor, not by returning
  // to the stale result that prompted it.
  if (step === 'init') return <InitScreen cwd={cwd} home={home} onDone={() => setStep('checking')} />;
  return (
    <Box flexDirection="column">
      <OverviewScreen checks={checks} items={MENU} cursor={cursor} />
      <Box marginTop={1}>
        <Text color={palette.MUTED}>{`↑↓ move   enter open   ^t ${themeName === 'dark' ? 'light' : 'dark'} theme   q quit`}</Text>
      </Box>
    </Box>
  );
}

/** Render the TUI and resolve with the process exit code. */
export async function runConfigTui(opts: { cwd: string; home?: string; start?: Step }): Promise<number> {
  // Resolved once here so every screen takes a required `home`: `configPath`
  // and `loadConfig` both demand one, and threading an optional down would put
  // the same `?? homedir()` in each screen.
  const home = opts.home ?? homedir();
  const instance = render(
    <ThemeProvider>
      <Ground><ConfigTui cwd={opts.cwd} home={home} start={opts.start} /></Ground>
    </ThemeProvider>,
  );
  await instance.waitUntilExit();
  return 0;
}
