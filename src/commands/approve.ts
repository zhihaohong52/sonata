import { readMeta, writeAnsweredPrompt } from '../store.js';
import { getAdapter } from '../adapters/index.js';
import { capturePane, hasSession, sendKeys } from '../tmux.js';
import { cleanPane } from '../normalize.js';

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

  const keys = opts.yes ? adapter.approveKeys.yes : adapter.approveKeys.no;
  if (keys.length === 0) {
    throw new Error(
      `sonata: the ${adapter.name} harness cannot be answered from outside. ` +
      `Attach with \`tmux attach -t ${meta.session}\` to respond directly.`,
    );
  }
  const prompt = adapter.describePrompt(cleanPane(await capturePane(meta.session)));
  if (prompt !== null) writeAnsweredPrompt(opts.cwd, opts.id, prompt);
  for (const key of keys) await sendKeys(meta.session, key);
}
