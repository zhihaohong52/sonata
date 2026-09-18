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
function ConfigTui({ cwd, home }: { cwd: string; home: string }): React.ReactElement {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('checking');
  const [checks, setChecks] = useState<Check[]>([]);

  useEffect(() => {
    if (step !== 'checking') return;
    let cancelled = false;
    cmdDoctor({ cwd, home })
      .then((result) => {
        if (cancelled) return;
        setChecks(result.checks);
        setStep('overview');
      })
      .catch(() => {
        // A machine doctor cannot describe is still one the TUI must open on,
        // so an empty result routes to an overview that says "no checks ran"
        // rather than leaving a spinner running forever.
        if (cancelled) return;
        setChecks([]);
        setStep('overview');
      });
    return () => { cancelled = true; };
  }, [step, cwd, home]);

  useInput((input, key) => {
    if (step === 'overview' && (input === 'q' || key.escape)) { exit(); return; }
    setStep((current) => nextStep(current, key.escape ? 'escape' : input));
  });

  if (step === 'checking') return <Text>checking…</Text>;
  if (step === 'budget') return <BudgetScreen cwd={cwd} home={home} />;
  if (step === 'models') return <ModelsScreen cwd={cwd} home={home} />;
  if (step === 'providers') return <ProvidersScreen cwd={cwd} home={home} />;
  if (step === 'tiers') return <TiersScreen cwd={cwd} home={home} onBack={() => setStep('overview')} />;
  if (step === 'keys') return <KeysScreen cwd={cwd} home={home} />;
  return (
    <Box flexDirection="column">
      <OverviewScreen checks={checks} />
    </Box>
  );
}

/** Render the TUI and resolve with the process exit code. */
export async function runConfigTui(opts: { cwd: string; home?: string }): Promise<number> {
  // Resolved once here so every screen takes a required `home`: `configPath`
  // and `loadConfig` both demand one, and threading an optional down would put
  // the same `?? homedir()` in each screen.
  const home = opts.home ?? homedir();
  const instance = render(<ConfigTui cwd={opts.cwd} home={home} />);
  await instance.waitUntilExit();
  return 0;
}
