import { readMeta } from '../store.js';
import { getAdapter } from '../adapters/index.js';
import { hasSession, sendKeys } from '../tmux.js';

export interface ApproveOptions { cwd: string; id: string; yes: boolean }

export async function cmdApprove(opts: ApproveOptions): Promise<void> {
  const meta = readMeta(opts.cwd, opts.id);
  const adapter = getAdapter(meta.harness);

  if (!(await hasSession(meta.session))) {
    throw new Error(
      `sonata: no live tmux session "${meta.session}" for run ${opts.id}. ` +
      `The run has already ended; check its report instead.`,
    );
  }

  const key = opts.yes ? adapter.approveKeys.yes : adapter.approveKeys.no;
  await sendKeys(meta.session, key);
  await sendKeys(meta.session, 'Enter');
}
