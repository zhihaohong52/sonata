import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { cmdInit } from '../../commands/init.js';
import { InitWizard, type WizardData } from '../app.js';
import type { TuiResult } from '../types.js';
import { Screen } from '../components/screen.js';
import { usePalette } from '../theme-context.js';

/**
 * What the host is being asked to draw right now.
 *
 * `cmdInit` runs as an ordinary async pipeline and reaches two points where it
 * needs a human: the wizard, and the write confirmation. Each one parks here
 * with the promise that resumes it, so the pipeline is suspended by React
 * state rather than by a second Ink instance — which is the thing that must
 * not happen. Two Ink instances on one stdout corrupt each other silently, and
 * unmounting the shell to hand off is worse: Ink unrefs stdin on unmount, so
 * whatever asks for a keystroke next is not work node knows about and the
 * process exits 0 with nothing written.
 */
type Pending =
  | { kind: 'wizard'; data: WizardData; resolve: (result: TuiResult) => void }
  | { kind: 'confirm'; question: string; resolve: (ok: boolean) => void };

/** The yes/no screen, standing in for `src/tui.ts`'s `confirm`. */
export function ConfirmScreen({ question, onAnswer }: { question: string; onAnswer: (ok: boolean) => void }): React.ReactElement {
  const palette = usePalette();
  const [choice, setChoice] = useState(true);
  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow) { setChoice((c) => !c); return; }
    if (input === 'y') { onAnswer(true); return; }
    if (input === 'n' || key.escape) { onAnswer(false); return; }
    if (key.return) onAnswer(choice);
  });
  // The question carries its own copy of the summary for the reason
  // `src/tui.ts` records: its confirm draws in the alternate screen buffer,
  // which hid everything printed before it and asked the user to approve a
  // summary they could no longer read. Here nothing is hidden, and the copy
  // costs nothing — so it stays rather than being trimmed on the assumption
  // that this host will always be the one drawing.
  const lines = question.split('\n');
  const prompt = lines[lines.length - 1] ?? question;
  return (
    <Screen title="Setup" note="nothing has been written yet" footer="←→ choose   enter confirm   y / n   esc cancel">
      {lines.slice(0, -1).map((line, i) => (
        <Text key={i} color={palette.MUTED}>{line}</Text>
      ))}
      <Box marginTop={1}><Text bold>{prompt}</Text></Box>
      <Box marginTop={1}>
        <Text color={choice ? palette.ACCENT : palette.MUTED}>{choice ? '▌ yes' : '  yes'}</Text>
        <Text color={!choice ? palette.ACCENT : palette.MUTED}>{!choice ? '   ▌ no' : '     no'}</Text>
      </Box>
    </Screen>
  );
}

/**
 * `sonata init`, hosted inside the shell.
 *
 * The pipeline is `cmdInit`'s, unchanged. This screen supplies only the two
 * interactive surfaces through `InitOptions.host` and renders whatever the
 * pipeline parks here. Reimplementing the pipeline was the alternative, and it
 * would have been a second writer of `sonata.toml` carrying none of the
 * guards the first one has — the file is *fully rewritten* by init, so
 * anything a second implementation failed to carry through would be deleted
 * rather than left alone.
 *
 * Everything init prints is captured rather than written to stdout: Ink patches
 * the console and a stray `console.log` lands above the app, outside the
 * palette and outside the layout. The lines become the done screen, which is
 * where they were always headed.
 */
export function InitScreen({ cwd, home, onDone }: { cwd: string; home: string; onDone: () => void }): React.ReactElement {
  const palette = usePalette();
  const [pending, setPending] = useState<Pending>();
  const [output, setOutput] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [finished, setFinished] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // Once. In StrictMode or on a re-render this would otherwise start a
    // second init against the same config, and init is the one command that
    // rewrites the file whole.
    if (started.current) return;
    started.current = true;
    const lines: string[] = [];
    void cmdInit({
      cwd,
      home,
      packageRoot: new URL('../../..', import.meta.url).pathname,
      write: (line) => { lines.push(line); },
      host: {
        runTui: (data) => new Promise<TuiResult>((resolve) => {
          setPending({ kind: 'wizard', data, resolve });
        }),
        confirm: (question) => new Promise<boolean>((resolve) => {
          setPending({ kind: 'confirm', question, resolve });
        }),
      },
    })
      .then(() => { setOutput(lines); setFinished(true); })
      .catch((cause: unknown) => {
        // Rendered, not thrown. A throw here unmounts the shell and takes the
        // reason with it — and `cmdInit` writes a log precisely because the
        // screen it owns does not survive the run, so the path is the useful
        // half of the message.
        setOutput(lines);
        setError(cause instanceof Error ? cause.message : String(cause));
        setFinished(true);
      })
      .finally(() => { setPending(undefined); });
  }, [cwd, home]);

  useInput((_input, key) => {
    if (finished && (key.return || key.escape)) onDone();
  }, { isActive: finished });

  if (pending?.kind === 'wizard') {
    return (
      <InitWizard
        data={pending.data}
        onDone={(result) => { setPending(undefined); pending.resolve(result); }}
      />
    );
  }
  if (pending?.kind === 'confirm') {
    return (
      <ConfirmScreen
        question={pending.question}
        onAnswer={(ok) => { setPending(undefined); pending.resolve(ok); }}
      />
    );
  }
  if (!finished) {
    return (
      <Screen title="Setup" note="nothing has been written yet" footer="">
        <Text color={palette.MUTED}>Looking at what is installed and what it can reach…</Text>
      </Screen>
    );
  }
  return (
    <Screen
      title="Setup"
      note={error === undefined ? 'done' : 'did not finish'}
      footer="enter back to sonata"
    >
      {output.filter((line) => line.trim() !== '').map((line, i) => (
        <Text key={i} color={palette.MUTED}>{line}</Text>
      ))}
      {error !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.HIGH}>{error}</Text>
          <Text color={palette.MUTED}>{`The full run is in ${home}/.config/sonata/logs/.`}</Text>
        </Box>
      )}
    </Screen>
  );
}
