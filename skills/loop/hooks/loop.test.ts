import { test, expect } from 'claude-code/testing'
import { applyLoopAction, isSonataAgent } from './model'
import type { Loop } from '../types'

const planned = (): Loop => {
  const r = applyLoopAction(null, { action: 'plan', title: 'auth', tasks: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }] }, 0)
  if ('error' in r || r.loop === null) throw new Error('plan failed')
  return r.loop
}
const ok = (r: ReturnType<typeof applyLoopAction>): Loop => {
  if ('error' in r) throw new Error(r.error)
  return r.loop!
}

test('plan creates pending tasks', () => {
  expect(planned().tasks.map(t => t.state)).toEqual(['pending', 'pending'])
})

test('start, failing result, fix, passing result', () => {
  let loop = ok(applyLoopAction(planned(), { action: 'start', taskId: '1', phase: 'code' }, 1))
  expect(loop.tasks[0].state).toBe('coding')
  expect(loop.pendingTaskId).toBe('1')
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'review' }, 2))
  loop = ok(applyLoopAction(loop, { action: 'result', taskId: '1', outcome: 'fail' }, 3))
  expect(loop.tasks[0]).toMatchObject({ failures: 1, openPhase: undefined })
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'fix' }, 4))
  expect(loop.tasks[0].state).toBe('fixing')
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'review' }, 5))
  loop = ok(applyLoopAction(loop, { action: 'result', taskId: '1', outcome: 'pass' }, 6))
  expect(loop.tasks[0].state).toBe('done')
})

test('a second start without a result replaces the open phase', () => {
  let loop = ok(applyLoopAction(planned(), { action: 'start', taskId: '1', phase: 'review' }, 1))
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'fix' }, 2))
  expect(loop.tasks[0]).toMatchObject({ state: 'fixing', openPhase: 'fix' })
})

test('escalate and done', () => {
  let loop = ok(applyLoopAction(planned(), { action: 'escalate', taskId: '2', to: 'complex' }, 1))
  expect(loop.tasks[1].escalatedTo).toBe('complex')
  loop = ok(applyLoopAction(loop, { action: 'done', summary: 'shipped' }, 2))
  expect(loop).toMatchObject({ isDone: true, summary: 'shipped' })
})

test('validation errors', () => {
  const loop = planned()
  expect(applyLoopAction(loop, { action: 'start', taskId: '9', phase: 'code' }, 1)).toEqual({ error: 'unknown taskId "9"; the plan has 1, 2' })
  expect(applyLoopAction(loop, { action: 'result', taskId: '1', outcome: 'pass' }, 1)).toEqual({ error: 'result for task "1" with no start before it' })
  expect(applyLoopAction(loop, { action: 'plan', title: 'x', tasks: [] }, 1)).toEqual({ error: 'a loop is already running; call done first' })
  expect(applyLoopAction(null, { action: 'start', taskId: '1', phase: 'code' }, 1)).toEqual({ error: 'no loop: call plan first' })
  expect(applyLoopAction(loop, { action: 'jump' }, 1)).toEqual({ error: 'unknown action "jump"; expected plan, start, result, escalate or done' })
  expect(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'deploy' }, 1)).toEqual({ error: 'phase must be code, fix, review or final' })
  expect(applyLoopAction(null, { action: 'plan', title: 'x', tasks: [{ id: '1', title: 'a' }, { id: '1', title: 'b' }] }, 1)).toEqual({ error: 'duplicate task id "1"' })
})

test('sonata agent matcher', () => {
  for (const t of ['code-simple', 'review-auto', 'plan', 'native-explore-normal']) expect(isSonataAgent(t)).toBe(true)
  for (const t of ['general-purpose', 'Explore', 'coder', 'planner']) expect(isSonataAgent(t)).toBe(false)
})

test('a result clears a pending dispatch for its task, and only for its task', () => {
  let loop = ok(applyLoopAction(planned(), { action: 'start', taskId: '1', phase: 'review' }, 1))
  loop = ok(applyLoopAction(loop, { action: 'result', taskId: '1', outcome: 'pass' }, 2))
  expect(loop.pendingTaskId).toBeUndefined()
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '2', phase: 'code' }, 3))
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'fix' }, 4))
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '2', phase: 'review' }, 5))
  loop = ok(applyLoopAction(loop, { action: 'result', taskId: '1', outcome: 'fail' }, 6))
  expect(loop.pendingTaskId).toBe('2')
})
