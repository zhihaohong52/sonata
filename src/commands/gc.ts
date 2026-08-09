import { listSessions, killSession } from '../tmux.js';
import { listRuns, readExit } from '../store.js';

/** Kills tmux sessions whose run has finished. Live runs are never touched. */
export async function cmdGc(opts: { cwd: string }): Promise<string[]> {
  const sessions = await listSessions();
  const killed: string[] = [];

  for (const id of listRuns(opts.cwd)) {
    const session = `sonata-${id}`;
    if (!sessions.includes(session)) continue;
    if (readExit(opts.cwd, id) === null) continue;
    await killSession(session);
    killed.push(session);
  }
  return killed;
}
