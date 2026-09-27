import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * A port nothing is listening on, chosen by the kernel for this test alone.
 *
 * Fixed ports in fixtures collided twice over: `4000` is a real LiteLLM's
 * default and was live on the maintainer's machine while the suite ran, and
 * the hand-picked "unlikely" ones (43114–43123, 39217, …) were only unlikely
 * until something else took them. Binding `::` reserves the port on both
 * loopback families — the router's upstream is `localhost`, which resolves
 * to either — and closing it leaves the port free for the test to name.
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
