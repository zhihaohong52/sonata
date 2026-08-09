import { listSessions, killSession, currentSession } from '../tmux.js';
import { listRuns, readExit } from '../store.js';

/**
 * Kills tmux sessions whose run has finished. Live runs are never touched, and
 * neither is the session gc is itself running inside — an agent that manages
 * tmux can otherwise kill the pane it lives in, losing its own exit sentinel.
 */
export async function cmdGc(opts: { cwd: string }): Promise<string[]> {
  const sessions = await listSessions();
  const self = await currentSession();
  const killed: string[] = [];

  for (const id of listRuns(opts.cwd)) {
    const session = `sonata-${id}`;
    if (!sessions.includes(session)) continue;
    if (session === self) continue;
    if (readExit(opts.cwd, id) === null) continue;
    await killSession(session);
    killed.push(session);
  }
  return killed;
}
