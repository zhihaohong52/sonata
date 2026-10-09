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

test('the panel command does not take the skill\'s own /sonata-loop name', async ($, on) => {
  const names: string[] = []
  on('tool.register', () => ({ value: {} }))
  on('command.register', (_$, e) => { names.push((e as { name: string }).name); return { value: {} } })
  on('session.start', () => ({ cwd: '/tmp' }))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  expect(names).toEqual(['loop-panel'])
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
