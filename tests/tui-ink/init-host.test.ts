import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ConfirmScreen } from '../../src/tui-ink/screens/init.js';

const ENTER = '\r';
const LEFT = '\u001B[D';
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const QUESTION = ['  config: ./sonata.toml', '  agents: 12', 'Write these changes?'].join('\n');

const screen = (onAnswer: (ok: boolean) => void = () => {}) =>
  render(React.createElement(ConfirmScreen, { question: QUESTION, onAnswer }));

/**
 * The write confirmation, as the shell draws it.
 *
 * It replaces `src/tui.ts`'s `confirm` for hosted runs, and it is the last
 * gate before `sonata init` rewrites `sonata.toml` **whole** — so what is
 * worth pinning is not how it looks but that it cannot answer yes by
 * accident, and that it carries the summary it is asking about.
 */
describe('ConfirmScreen', () => {
  it('shows every line of the summary, not just the question', async () => {
    // `src/tui.ts`'s confirm draws in the alternate screen buffer, which hid
    // everything printed before it and asked the user to approve a summary
    // they could no longer read. The copy travels with the question so this
    // host cannot reintroduce that.
    const app = screen();
    await tick();
    expect(app.lastFrame()).toContain('config: ./sonata.toml');
    expect(app.lastFrame()).toContain('agents: 12');
    expect(app.lastFrame()).toContain('Write these changes?');
  });

  it('answers yes on enter, since yes is the default', async () => {
    const answers: boolean[] = [];
    const app = screen((ok) => answers.push(ok));
    await tick();
    app.stdin.write(ENTER);
    await tick();
    expect(answers).toEqual([true]);
  });

  it('answers no after moving the cursor off yes', async () => {
    const answers: boolean[] = [];
    const app = screen((ok) => answers.push(ok));
    await tick();
    app.stdin.write(LEFT);
    await tick();
    app.stdin.write(ENTER);
    await tick();
    expect(answers).toEqual([false]);
  });

  it('takes y and n directly', async () => {
    for (const [key, expected] of [['y', true], ['n', false]] as const) {
      const answers: boolean[] = [];
      const app = screen((ok) => answers.push(ok));
      await tick();
      app.stdin.write(key);
      await tick();
      expect(answers).toEqual([expected]);
    }
  });

  // Escape is handled as `no` in `ConfirmScreen`, and is deliberately NOT
  // tested here: a bare `\u001B` written to `ink-testing-library`'s stdin
  // produces no input event at all — verified with a probe component that
  // logged every keypress and saw none. Ink delivers it in a real terminal,
  // and the host's own `useInput` returns early while `step === 'init'`, so
  // nothing competes for it. Asserting it through this harness would mean
  // asserting something the harness cannot produce.
  //
  // The behaviour it guards is worth stating even so: escape must answer
  // `false` rather than dismiss the screen, because `cmdInit` is suspended on
  // the promise this resolves — an escape that answered nothing would park
  // the pipeline forever behind a blank Setup screen. `n` covers the same
  // branch below.

  it('says nothing has been written yet', async () => {
    // The reader is being asked to approve a rewrite of their config, and the
    // header has to make clear the rewrite has not happened.
    const app = screen();
    await tick();
    expect(app.lastFrame()).toContain('nothing has been written yet');
  });
});
