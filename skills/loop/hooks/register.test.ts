import { test, expect } from 'claude-code/testing'

const TOOL = 'mcp__sonata-loop__sonata_loop'
const said = (r: { deny?: string; text?: string }): string => r.deny ?? r.text ?? ''

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
