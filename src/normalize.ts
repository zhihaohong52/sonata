// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const SPINNER_ONLY = /^[⠁-⣿|/\\-]+$/;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export function cleanPane(raw: string): string[] {
  return stripAnsi(raw)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0 && !SPINNER_ONLY.test(l.trim()));
}

export function newLines(prev: string[], next: string[]): string[] {
  if (prev.length === 0) return next;

  const maxK = Math.min(prev.length, next.length);
  for (let k = maxK; k > 0; k--) {
    const prevTail = prev.slice(prev.length - k);
    const nextHead = next.slice(0, k);
    if (prevTail.every((line, i) => line === nextHead[i])) {
      return next.slice(k);
    }
  }
  return next;
}
