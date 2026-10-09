import { test, expect } from 'claude-code/testing'

const TOOL = 'mcp__sonata-loop__sonata_loop'
const PANE = { component: 'Pane', props: { title: 'sonata loop', isFocused: true, bodyColumns: 100 }, requestId: 'sonata-loop' } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`panel draws tasks and shows a diff when an agent is selected (${surface})`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('agent.spawn', () => ({ model: 'sonata-code-simple', agentId: 'a1' }))
    on('tool.call', { tool: 'Edit' }, () => ({ result: {}, text: 'ok' }))
    on('session.id', () => ({ value: 's1' }))
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"routes":[]}' } }))
    on('clock.sleep', () => new Promise(() => {}))
    await $.tool.call({ tool: TOOL, action: 'plan', title: 'auth', tasks: [{ id: '1', title: 'Retry queue' }] })
    await $.tool.call({ tool: TOOL, action: 'start', taskId: '1', phase: 'code' })
    await $.agent.spawn({ subagentType: 'code-simple', description: 'queue tests', prompt: 'x' } as never)
    await $.tool.call({ tool: 'Edit', agentId: 'a1', file_path: '/r/q.ts', old_string: 'retry(fn)', new_string: 'retry(fn, { backoff })' } as never)

    const ui = await $.ui.mount({ plugin: 'sonata-loop', surface, ...PANE })
    expect((await ui.find({ key: 'task:1' }))?.text).toMatch(/Retry queue/)
    expect((await ui.find({ key: 'agent:a1' }))?.text).toMatch(/code-simple/)
    expect(await ui.find({ text: /backoff/ })).toBeUndefined()
    await ui.press({ key: 'agent:a1' })
    expect(await ui.find({ text: /\+ retry\(fn, \{ backoff \}\)/ })).toBeDefined()
    await ui.press({ key: 'agent:a1' })
    expect(await ui.find({ text: /backoff/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('a new plan replaces the previous loop\'s agents', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'sonata-code-simple', agentId: 'old' }))
  on('session.id', () => ({ value: 's1' }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"routes":[]}' } }))
  on('clock.sleep', () => new Promise(() => {}))
  await $.agent.spawn({ subagentType: 'explore-simple', description: 'stray', prompt: 'x' } as never)
  await $.tool.call({ tool: TOOL, action: 'plan', title: 'two', tasks: [{ id: '1', title: 'B' }] })
  const ui = await $.ui.mount({ plugin: 'sonata-loop', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'agent:old' })).toBeUndefined()
  await ui.unmount()
})

test('"active only" still shows a running child of a finished parent', async ($, on) => {
  let next = 0
  const ids = ['p', 'c']
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'sonata-code-complex', agentId: ids[next++] }))
  on('session.id', () => ({ value: 's1' }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"routes":[]}' } }))
  on('clock.sleep', () => new Promise(() => {}))
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn({ subagentType: 'code-complex', description: 'parent', prompt: 'x' } as never)
  await $.agent.spawn({ subagentType: 'code-simple', description: 'child', prompt: 'x', parentAgentId: 'p' } as never)
  await $.turn.complete({ agentId: 'p', reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't' } as never)
  const ui = await $.ui.mount({ plugin: 'sonata-loop', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle:active' })
  expect(await ui.find({ key: 'agent:p' })).toBeUndefined()
  expect(await ui.find({ key: 'agent:c' })).toBeDefined()
  await ui.unmount()
})

test('/clear also clears the router footer', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'sonata-code-simple', agentId: 'a1' }))
  on('session.id', () => ({ value: 's1' }))
  on('http.fetch', () => { throw new Error('down') })
  let parked!: () => void
  const isParked = new Promise<void>(r => { parked = r })
  on('clock.sleep', () => { parked(); return new Promise(() => {}) })
  on('session.end', () => ({ sessionId: 's' }))
  await $.agent.spawn({ subagentType: 'code-simple', description: 'x', prompt: 'x' } as never)
  await isParked
  await $.session.end({ reason: 'clear' })
  const ui = await $.ui.mount({ plugin: 'sonata-loop', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: /router not reachable/ })).toBeUndefined()
  await ui.unmount()
})
