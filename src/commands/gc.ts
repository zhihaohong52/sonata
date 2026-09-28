import { listSessions, killSession, currentSession } from '../tmux.js';
import { isRunId, listRuns, readExit, runDir } from '../store.js';
import { captureTranscript } from '../transcript.js';

/**
 * Kills tmux sessions whose run has finished, capturing each run's transcript
 * first if tail has not. Live runs are never touched, and neither is the
 * session gc is itself running inside — an agent that manages tmux can
 * otherwise kill the pane it lives in, losing its own exit sentinel.
 */
export async function cmdGc(opts: { cwd: string }): Promise<string[]> {
  const sessions = await listSessions();
  const self = await currentSession();
  const killed: string[] = [];

  for (const id of listRuns(opts.cwd)) {
    // A stray directory under .sonata/runs is not a run; `runDir` refuses it.
    if (!isRunId(id)) continue;
    const session = `sonata-${id}`;
    if (!sessions.includes(session)) continue;
    if (session === self) continue;
    if (readExit(opts.cwd, id) === null) continue;
    // Killing the session destroys tmux's scrollback, the only full record of
    // what the run printed. Tail captures it when it sees the run finish, but a
    // run nobody tailed to the end has not been captured yet.
    await captureTranscript(session, runDir(opts.cwd, id));
    await killSession(session);
    killed.push(session);
  }
  return killed;
}
