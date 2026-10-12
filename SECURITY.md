# Security policy

## Reporting a vulnerability

Please report security issues **privately**, through the repository's
[Security tab](https://github.com/zhihaohong52/sonata/security/advisories/new)
("Report a vulnerability"), rather than in a public issue or pull request.

Include what you ran, what happened, and what you expected — a reproduction,
the sonata version (`sonata --version`) and the harness involved help most.
Sonata is pre-1.0, so fixes land on the latest release only.

## Scope

In scope: anything sonata itself does wrong — the local router (`sonata
serve`) forwarding a credential somewhere it should not, a gateway key leaking
into a log, an argv or a config file, a permission mode being widened rather
than refused, the launch wrapper or hooks running something they should not.

Out of scope: the behaviour of the harnesses sonata launches (OpenCode, Codex,
Pi, Reasonix, Claude Code) and of the models behind them. Report those
upstream.

## What sonata does and does not protect against

Sonata launches other coding agents on your machine; they run **as you**. Read
[docs/guide/security.md](docs/guide/security.md) for the threat model — which
harnesses sandbox and which do not, where credentials live, what auto-routing
sends off the machine, and why prompt injection matters more with foreign
models.
