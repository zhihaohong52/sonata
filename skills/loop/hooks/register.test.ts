import { test, expect } from 'claude-code/testing'

const TOOL = 'mcp__sonata-loop__sonata_loop'
const said = (r: { deny?: string; text?: string; result?: unknown }): string =>
  r.deny ?? r.text ?? (typeof r.result === 'string' ? r.result : '')

test('the tool validates and records the plan', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  expect(said(await $.tool.call({ tool: TOOL, action: 'start', taskId: '1', phase: 'code' }))).toMatch(/call plan first/)
  expect(said(await $.tool.call({ tool: TOOL, action: 'plan', title: 't', tasks: [{ id: '1', title: 'A' }] }))).toMatch(/1 task/)
  expect(said(await $.tool.call({ tool: TOOL, action: 'start', taskId: '1', phase: 'code' }))).toMatch(/recorded/)
})

test('/clear empties the panel', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.end', () => ({ sessionId: 's' }))
  await $.tool.call({ tool: TOOL, action: 'plan', title: 't', tasks: [{ id: '1', title: 'A' }] })
  await $.session.end({ reason: 'clear' })
  expect(said(await $.tool.call({ tool: TOOL, action: 'start', taskId: '1', phase: 'code' }))).toMatch(/call plan first/)
})

test('the tool answers with a string result, the shape the host accepts', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const r = await $.tool.call({ tool: TOOL, action: 'plan', title: 't', tasks: [{ id: '1', title: 'A' }] })
  expect(typeof (r as { result?: unknown }).result).toBe('string')
})

test('registers no command of its own: the panel rides on the skill\'s /sonata-loop', async ($, on) => {
  const names: string[] = []
  on('tool.register', () => ({ value: {} }))
  on('command.register', (_$, e) => { names.push((e as { name: string }).name); return { value: {} } })
  on('session.start', () => ({ cwd: '/tmp' }))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  expect(names).toEqual([])
})

test('/sonata-loop panel toggles the pane and runs no skill', async ($, on) => {
  const opened: string[] = []
  let closed = 0
  let skillRuns = 0
  let panes: { id: string }[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_$, e) => { opened.push((e as { id: string }).id); return { value: { isPlaced: true } } })
  on('ui.close', () => { closed++; return { value: {} } })
  on('command.run', () => { skillRuns++; return { text: 'skill ran' } })
  const run = (args: string) => $.command.run({ command: 'sonata-loop', args } as never)
  expect((await run('panel')).text).toBe('Loop panel opened.')
  expect(opened).toEqual(['sonata-loop'])
  panes = [{ id: 'sonata-loop' }]
  expect((await run(' Panel ')).text).toBe('Loop panel closed.')
  expect(closed).toBe(1)
  expect(skillRuns).toBe(0)
})

test('/sonata-loop with anything else runs the skill as typed', async ($, on) => {
  const seen: string[] = []
  on('command.run', (_$, e) => { seen.push((e as { args: string }).args); return { text: 'skill ran' } })
  expect((await $.command.run({ command: 'sonata-loop', args: 'add a logout button' } as never)).text).toBe('skill ran')
  expect((await $.command.run({ command: 'sonata-loop', args: '' } as never)).text).toBe('skill ran')
  expect(seen).toEqual(['add a logout button', ''])
})

test('an agent finishing triggers one more router fetch, so its last request is counted', async ($, on) => {
  let fetches = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'sonata-code-simple', agentId: 'a1' }))
  on('session.id', () => ({ value: 's1' }))
  on('http.fetch', () => { fetches++; return { value: { status: 200, ok: true, headers: {}, text: '{"routes":[]}' } } })
  let parked!: () => void
  const isParked = new Promise<void>(r => { parked = r })
  on('clock.sleep', () => { parked(); return new Promise(() => {}) })
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn({ subagentType: 'code-simple', description: 'x', prompt: 'x' } as never)
  await isParked
  const before = fetches
  await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't' } as never)
  expect(fetches).toBe(before + 1)
})
