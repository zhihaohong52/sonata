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
