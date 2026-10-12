import { defineConfig } from 'vitepress'

const repo = 'https://github.com/zhihaohong52/sonata'

// The site publishes the user-facing guide only. The maintainer's design
// record (internals/, superpowers/, reviews/, HANDOFF.md) stays in the
// repository, where it is read alongside the code it describes; guide pages
// that point at it link to GitHub instead.
export default defineConfig({
  title: 'sonata',
  description: 'Foreign-model subagents for Claude Code',
  base: '/sonata/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: [
    'internals/**',
    'superpowers/**',
    'reviews/**',
    'HANDOFF.md',
    'dispatching-work-through-sonata.md',
    'README.md',
  ],
  rewrites: {
    'guide/README.md': 'guide/index.md',
  },
  head: [['meta', { name: 'theme-color', content: '#d7875f' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Commands', link: '/guide/commands' },
      { text: 'Roadmap', link: '/roadmap' },
      { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Commands', link: '/guide/commands' },
          { text: 'Configuration', link: '/guide/configuration' },
        ],
      },
      {
        text: 'Running models',
        items: [
          { text: 'Native path', link: '/guide/native-path' },
          { text: 'Codex subscription auth', link: '/guide/codex-subscription' },
          { text: 'Permission modes', link: '/guide/permission-modes' },
        ],
      },
      {
        text: 'Before you depend on it',
        items: [
          { text: 'Security', link: '/guide/security' },
          { text: 'Limitations', link: '/guide/limitations' },
          { text: 'Troubleshooting', link: '/guide/troubleshooting' },
        ],
      },
      {
        text: 'Extending',
        items: [
          { text: 'Adding a harness', link: '/guide/adding-a-harness' },
          { text: 'Roadmap to 1.0', link: '/roadmap' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    search: { provider: 'local' },
    footer: {
      message: 'Released under the MIT License. Public beta — pre-1.0.',
    },
  },
})
