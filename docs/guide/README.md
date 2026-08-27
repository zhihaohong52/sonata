# Guide

Deep-dive reference for sonata, once you're past the basics in the
[README](../../README.md). Each page stands alone — read whichever one
answers your current question.

| Page | Covers |
|---|---|
| [Native path](native-path.md) | Running foreign models inside Claude Code's own loop through the local routing proxy — `sonata serve`, `sonata code`, `sonata route on/auto` |
| [Codex subscription auth](codex-subscription.md) | How the `codex-oauth` gateway type authenticates against a ChatGPT subscription instead of a metered API key |
| [Permission modes](permission-modes.md) | How each harness (OpenCode, Pi, Codex, Reasonix) honours Claude Code's permission modes, and where enforcement is real vs. advisory |
| [Configuration](configuration.md) | The `sonata.toml` schema, where it's resolved from, and how roles/tiers work |
| [Troubleshooting](troubleshooting.md) | Symptom → cause table for common failures |
| [Security](security.md) | What sonata does and doesn't protect against when running foreign models on your machine |
| [Limitations](limitations.md) | Known gaps and upstream quirks worth knowing before depending on this |
| [Adding a harness](adding-a-harness.md) | The adapter extension point, for anyone integrating a new harness |
