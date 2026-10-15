/**
 * The check on a configured base URL, shared by the config parser and the
 * wizard so the two cannot disagree. This module imports nothing, so the
 * parser, the wizard and detection can all use it.
 *
 * The refused shapes are the ones where URL parsers can disagree about where
 * the authority ends. Probed 2026-10-15 with `https://openrouter.ai\@evil.example/api/v1`:
 * Node's `URL` gives host `openrouter.ai`, while httpx (the client LiteLLM sends
 * with, sonata's own venv, 0.28.1) and urllib give `evil.example`. So refused:
 * a backslash, `@` (userinfo), a `%` in the authority, a query, a fragment,
 * whitespace or a control character inside the URL, a non-http scheme, and a
 * URL that does not parse. Everything else is accepted and normalised by `URL`:
 * an uppercase scheme, a punycode or IDN host, an underscore host (docker-compose
 * names such as `ollama_server`), a default port, and whitespace around the whole
 * string. Probe, same venv: httpx's `raw_host` (the bytes sent) equals Node's
 * href for `http://ollama_server:11434/v1` and for `https://bücher.example/v1`,
 * which both become `xn--bcher-kva.example`. Only the href is stored.
 */

/** The outcome of checking one URL: its canonical href, or why it is refused. */
export type BaseUrlCheck = { href: string } | { problem: string };

export function checkBaseUrl(raw: unknown): BaseUrlCheck {
  if (typeof raw !== 'string') return { problem: 'it is not a string' };
  const text = raw.trim();
  if (text === '') return { problem: 'it is empty' };
  if (/[\\@]/.test(text)) return { problem: 'a backslash or @ is not allowed' };
  if (/[\x00-\x20\x7f]/.test(text)) return { problem: 'no whitespace or control character is allowed inside the URL' };
  if (text.includes('?') || text.includes('#')) return { problem: 'a query string or fragment is not allowed' };
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(text);
  if (scheme === null) return { problem: 'it needs a scheme, http:// or https://' };
  const authority = text.slice(scheme[0].length).split('/')[0] ?? '';
  if (authority.includes('%')) return { problem: 'a percent-encoded character is not allowed in the host' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: 'it does not parse as a URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: 'the scheme must be http or https' };
  if (url.username !== '' || url.password !== '') return { problem: 'userinfo is not allowed' };
  // A bare origin gets a trailing slash from `URL`, which the stored form does
  // not carry (sonata appends its own path to the base).
  return { href: url.pathname === '/' ? url.href.slice(0, -1) : url.href };
}

/**
 * The canonical form of a configured base URL: the href `checkBaseUrl` gives.
 * Throws, naming `where`, for anything refused.
 */
export function canonicalBaseUrl(raw: unknown, where: string): string {
  const check = checkBaseUrl(raw);
  if ('problem' in check) {
    throw new Error(
      `sonata.toml: ${where} must be an absolute http(s) URL — ${check.problem} — got ${JSON.stringify(String(raw))}. ` +
      'Write a plain URL: a scheme, a host, an optional port, and a path.',
    );
  }
  return check.href;
}

/** `canonicalBaseUrl` for a URL typed at run time: undefined when it is refused. */
export function canonicalBaseUrlOrUndefined(raw: unknown): string | undefined {
  const check = checkBaseUrl(raw);
  return 'href' in check ? check.href : undefined;
}
