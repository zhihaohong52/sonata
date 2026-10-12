import { test, expect } from 'claude-code/testing'

// The poll is started with `void poll($)`. A sleep the engine rejects (a test
// torn down, a plugin reloaded mid-sleep) must stop the poll quietly, never
// escape as an unhandled rejection.
test('a rejected sleep stops the poll without an unhandled rejection', async ($, on) => {
  let slept = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'sonata-code-simple', agentId: 'a1' }))
  on('session.id', () => ({ value: 's1' }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"routes":[]}' } }))
  on('clock.sleep', () => { slept++; return Promise.reject(new Error('environment gone')) })
  await $.agent.spawn({ subagentType: 'code-simple', description: 'x', prompt: 'x' } as never)
  for (let i = 0; i < 20 && slept === 0; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 20))
  expect(slept).toBeGreaterThan(0)
})
