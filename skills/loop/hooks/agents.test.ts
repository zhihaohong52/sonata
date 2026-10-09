import { test, expect } from 'claude-code/testing'
import { applyLoopAction, spawnAgent, stepAgent, toolActivity, completeAgent, childrenOf, depthOf } from './model'
import type { Loop, AgentRow } from '../types'

const started = (): Loop => {
  const p = applyLoopAction(null, { action: 'plan', title: 't', tasks: [{ id: '1', title: 'A' }] }, 0) as { loop: Loop }
  return (applyLoopAction(p.loop, { action: 'start', taskId: '1', phase: 'code' }, 1) as { loop: Loop }).loop
}

test('a top-level sonata spawn attaches to the pending task and clears it', () => {
  const s = spawnAgent({ loop: started(), agents: [] }, { agentId: 'a1', subagentType: 'code-normal', description: 'do A' }, 5)
  expect(s.agents[0]).toMatchObject({ id: 'a1', taskId: '1', status: 'running', steps: 0 })
  expect(s.loop!.pendingTaskId).toBeUndefined()
  expect(s.loop!.tasks[0].agentIds).toEqual(['a1'])
})

test('a child joins its parent\'s task, not the pending one', () => {
  let s = spawnAgent({ loop: started(), agents: [] }, { agentId: 'a1', subagentType: 'code-complex', description: 'A' }, 5)
  s = { ...s, loop: (applyLoopAction(s.loop, { action: 'start', taskId: '1', phase: 'review' }, 6) as { loop: Loop }).loop }
  s = spawnAgent(s, { agentId: 'c1', subagentType: 'code-simple', description: 'part', parentAgentId: 'a1' }, 7)
  expect(s.agents.find(a => a.id === 'c1')).toMatchObject({ parentId: 'a1', taskId: '1' })
  expect(s.loop!.pendingTaskId).toBe('1')
  expect(childrenOf(s.agents, 'a1').map(a => a.id)).toEqual(['c1'])
  expect(depthOf(s.agents, 'c1')).toBe(1)
})

test('unplanned and non-sonata spawns', () => {
  const s1 = spawnAgent({ loop: null, agents: [] }, { agentId: 'u', subagentType: 'explore-simple', description: 'x' }, 1)
  expect(s1.agents[0].taskId).toBeUndefined()
  const s2 = spawnAgent({ loop: null, agents: [] }, { agentId: 'g', subagentType: 'general-purpose', description: 'x' }, 1)
  expect(s2.agents).toEqual([])
})

test('a child of a non-sonata parent is still tracked, with no task', () => {
  const s = spawnAgent({ loop: started(), agents: [] }, { agentId: 'c', subagentType: 'code-simple', description: 'x', parentAgentId: 'gp' }, 1)
  expect(s.agents[0]).toMatchObject({ parentId: 'gp', taskId: undefined })
  expect(s.loop!.pendingTaskId).toBe('1')
})

test('steps, activity and completion', () => {
  let agents: AgentRow[] = spawnAgent({ loop: null, agents: [] }, { agentId: 'a', subagentType: 'code-simple', description: 'x' }, 0).agents
  agents = stepAgent(agents, { agentId: 'a', model: 'sonata-code-simple' }, 10)
  agents = toolActivity(agents, { agentId: 'a', tool: 'Edit', input: { file_path: '/r/src/q.ts' } })
  expect(agents[0]).toMatchObject({ steps: 1, alias: 'sonata-code-simple', stepTimes: [10], activity: 'Edit q.ts' })
  agents = toolActivity(agents, { agentId: 'a', tool: 'Bash', input: { command: 'sed -i s/a/b/ x' } })
  expect(agents[0]).toMatchObject({ activity: 'Bash sed', usedBash: true })
  agents = completeAgent(agents, { agentId: 'a', reason: 'aborted' }, 20)
  expect(agents[0]).toMatchObject({ status: 'aborted', endedAt: 20, activity: undefined })
  expect(stepAgent(agents, { agentId: 'zzz', model: 'm' }, 1)).toBe(agents)
})
