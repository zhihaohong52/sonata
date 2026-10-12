---
layout: home

hero:
  name: sonata
  text: Foreign-model subagents for Claude Code
  tagline: Dispatch a subagent backed by a different model, through the ordinary Agent tool. Same interface, same working directory, same report contract — different brain.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/zhihaohong52/sonata

features:
  - title: Cost
    details: Mechanical work — bulk refactors, test scaffolding, migrations — does not need a frontier model. Route it to a cheap, high-cache model and keep Claude for the work that needs it.
  - title: Diversity of judgement
    details: Asking Claude to review Claude's work surfaces fewer problems than asking a different model family. Review is where a second opinion actually pays.
  - title: Native, with a fallback
    details: Tier agents run inside Claude Code's own loop through a local router that tries a ranked list of models. When every native route fails, sonata dispatch runs the task in the model's own CLI instead.
---

![The code-complex tier in sonata agents](/screenshots/tier-ranking.png)

::: warning Public beta
Sonata is pre-1.0 and under active development. Read
[Limitations](/guide/limitations) and [Security](/guide/security) before
depending on it — foreign models run on your machine, as you.
:::
