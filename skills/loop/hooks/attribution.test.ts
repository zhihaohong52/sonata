import { test, expect } from 'claude-code/testing'
import { attribute, taskCost } from './model'
import type { AgentRow, RouteLine } from '../types'

const agent = (id: string, startedAt: number, endedAt: number | undefined, steps: number[]): AgentRow => ({
  id, type: 'code-simple', description: id, status: endedAt ? 'done' : 'running', steps: steps.length,
  alias: 'sonata-code-simple', stepTimes: steps, usedBash: false, hunks: [], startedAt, endedAt,
})
const route = (ms: number, served: string, priceUsd?: number): RouteLine =>
  ({ alias: 'sonata-code-simple', served, status: 200, ts: new Date(ms).toISOString(), tier: 'simple', priceUsd })

test('one agent on the alias: exact model, tier and cost', () => {
  const agents = [agent('a', 0, 50_000, [1_000, 20_000])]
  const routes = [route(2_000, 'flash', 0.01), route(21_000, 'flash', 0.02)]
  expect(attribute(agents, routes, 'a')).toEqual({ served: ['flash'], tier: 'simple', usd: 0.03, isExact: true })
})

test('two concurrent agents on one alias: models shown, no cost assigned', () => {
  const agents = [agent('a', 0, undefined, [1_000]), agent('b', 500, undefined, [1_200])]
  const routes = [route(2_000, 'flash', 0.01), route(2_100, 'kimi', 0.05)]
  expect(attribute(agents, routes, 'a')).toEqual({ served: ['flash', 'kimi'], tier: 'simple', usd: undefined, isExact: false })
  expect(taskCost(agents, routes, ['a', 'b'])).toEqual({ usd: 0, isPartial: true })
})

test('an unpriced route makes the agent cost unknown, not 0', () => {
  const agents = [agent('a', 0, 10_000, [1_000])]
  expect(attribute(agents, [route(2_000, 'flash')], 'a').usd).toBeUndefined()
  expect(taskCost(agents, [route(2_000, 'flash')], ['a'])).toEqual({ usd: 0, isPartial: true })
})

test('no routes (router unreachable): nothing served, cost unknown', () => {
  expect(attribute([agent('a', 0, undefined, [1_000])], [], 'a')).toEqual({ served: [], tier: undefined, usd: undefined, isExact: false })
})

test('back-to-back agents on one alias: the running one is exact, the finished one does not claim its routes', () => {
  const agents = [agent('a', 0, 50_000, [1_000, 20_000]), agent('b', 59_000, undefined, [60_000])]
  const routes = [route(61_000, 'flash', 0.02)]
  expect(attribute(agents, routes, 'b')).toEqual({ served: ['flash'], tier: 'simple', usd: 0.02, isExact: true })
  expect(attribute(agents, routes, 'a').served).toEqual([])
})
