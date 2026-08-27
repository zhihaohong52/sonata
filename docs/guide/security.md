# Security

Sonata launches other coding agents on your machine. They run **as you**, with
your files and your credentials.

- **Read the [permission tables](permission-modes.md) before dispatching write-capable roles.**
  Only codex offers a real sandbox. Pi has none, and opencode's is advisory.
- **Sonata never bypasses a harness's own safety flags.** It does not pass
  `--dangerously-bypass-approvals-and-sandbox` to codex.
- **Credentials stay with the harness.** Sonata reads harness config to report
  health; it does not copy, forward or log API keys. Keys live wherever the
  harness put them (e.g. `~/.config/opencode/opencode.json`).
- **Prompt injection is a real risk.** A foreign model reading a hostile
  repository can be steered, and it has no classifier between it and your
  files. For untrusted code, dispatch read-only roles or run in a container.

Please report security issues privately, through the repository's
[Security tab](https://github.com/zhihaohong52/sonata/security), rather than in
a public issue.
