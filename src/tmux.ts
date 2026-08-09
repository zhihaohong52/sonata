import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await run('tmux', args, { encoding: 'utf8' });
  return stdout;
}

export async function tmuxVersion(): Promise<string> {
  const out = await tmux(['-V']);
  return out.trim().replace(/^tmux\s+/, '');
}

/**
 * Creates a detached session running a persistent shell. The harness command is
 * sent separately via runScript so the pane outlives the command — without this
 * the pane-tail fallback is unavailable exactly when a harness crashes.
 */
export async function newSession(opts: { session: string; cwd: string }): Promise<void> {
  await tmux([
    'new-session', '-d',
    '-s', opts.session,
    '-c', opts.cwd,
    '-x', '200', '-y', '50',
  ]);
  await tmux(['set-option', '-t', opts.session, 'remain-on-exit', 'on']);
  await tmux(['set-option', '-t', opts.session, 'history-limit', '10000']);
}

export async function hasSession(session: string): Promise<boolean> {
  try {
    await tmux(['has-session', '-t', session]);
    return true;
  } catch {
    return false;
  }
}

export async function runScript(session: string, scriptPath: string): Promise<void> {
  await tmux(['send-keys', '-t', session, `bash ${JSON.stringify(scriptPath)}`, 'Enter']);
}

export async function sendKeys(session: string, keys: string): Promise<void> {
  await tmux(['send-keys', '-t', session, keys]);
}

export async function capturePane(session: string): Promise<string> {
  try {
    return await tmux(['capture-pane', '-p', '-t', session]);
  } catch {
    return '';
  }
}

export async function listSessions(): Promise<string[]> {
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}']);
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export async function killSession(session: string): Promise<void> {
  try {
    await tmux(['kill-session', '-t', session]);
  } catch {
    /* already gone */
  }
}
