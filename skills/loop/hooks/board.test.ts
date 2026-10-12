import { test, expect } from 'claude-code/testing'
import { panelTree, type PanelData } from './panel'
import type { AgentRow, Loop, RouteLine } from '../types'

// Render panelTree to plain rows: one string per line, with the colour of
// each run kept beside it so a test can ask what a span was drawn in.
type N = { type: string; props: any; children: any[] }
const h = (type: any, props: any, ...children: any[]): N => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const els = { Box: 'Box', Text: 'Text', Button: 'Button' }
function rows(tree: N): string[] {
  const out: string[] = []
  const text = (n: any): string => (n == null || n === false || n === true ? '' : typeof n === 'object' ? n.children.map(text).join('') : String(n))
  const walk = (n: any) => {
    if (n == null || n === false || n === true || n === '') return
    if (n.type === 'Box' && n.props.flexDirection !== 'row') { if (n.props.height === 0) return; n.children.forEach(walk); return }
    out.push(text(n))
  }
  walk(tree)
  return out
}
const colorOf = (tree: N, needle: string): string | undefined => {
  let found: string | undefined
  const walk = (n: any, c?: string) => {
    if (n == null || typeof n !== 'object') { if (typeof n === 'string' && n.includes(needle) && found === undefined) found = c; return }
    n.children.forEach((k: any) => walk(k, n.props?.color ?? c))
  }
  walk(tree)
  return found
}
const noop = { select() {}, toggleFold() {}, toggleActive() {}, jumpLatest() {}, copy() {} }

const NOW = 1_000_000
const agent = (o: Partial<AgentRow> & Pick<AgentRow, 'id' | 'type'>): AgentRow =>
  ({ description: 'd', taskId: '1', status: 'running', steps: 3, stepTimes: [], usedBash: false, hunks: [], startedAt: NOW - 60_000, ...o })
const loop = (agentIds: string[], extra: Partial<Loop['tasks'][0]> = {}): Loop =>
  ({ title: 't', startedAt: NOW - 60_000, isDone: false, tasks: [{ id: '1', title: 'Task one', state: 'coding', failures: 0, agentIds, ...extra }, { id: '2', title: 'Task two', state: 'pending', failures: 0, agentIds: [] }] })
const data = (o: Partial<PanelData>): PanelData =>
  ({ loop: null, agents: [], router: { routes: [], at: NOW - 1000 }, view: { showAll: true, expanded: [] }, now: NOW, cols: 72, ...o })
const draw = (d: PanelData) => panelTree(h, els, d, noop) as N

test('a running agent shows how long ago its last step was, and stalls past 90 s', () => {
  const live = agent({ id: 'a', type: 'code-auto', activity: 'Edit x.ts', stepTimes: [NOW - 4_000], steps: 26 })
  const stuck = agent({ id: 'b', type: 'code-auto', activity: 'Bash npm', stepTimes: [NOW - 120_000] })
  const r = rows(draw(data({ loop: loop(['a', 'b']), agents: [live, stuck] })))
  expect(r.some(l => /Edit x\.ts · step 26 · 4s ago/.test(l))).toBe(true)
  expect(r.find(l => /code-auto/.test(l) && /stalled/.test(l))).toBeDefined()
  expect(r.filter(l => /code-auto/.test(l) && /running/.test(l))).toHaveLength(1)
})

test('the step count leaves the row for the activity line', () => {
  const done = agent({ id: 'a', type: 'code-auto', status: 'done', steps: 11, endedAt: NOW - 1000, stepTimes: [NOW - 2000] })
  const row = rows(draw(data({ loop: loop(['a']), agents: [done] }))).find(l => /code-auto/.test(l))!
  expect(row).not.toMatch(/\b11\b/)
})

test('the tier drops for the whole column when any row would overflow', () => {
  const a = agent({ id: 'a', type: 'code-auto', alias: 'x', stepTimes: [NOW - 50_000] })
  const b = agent({ id: 'b', type: 'review-auto', alias: 'y', stepTimes: [NOW - 50_000] })
  const routes: RouteLine[] = [
    { alias: 'x', served: 'a-very-long-model-name-v2.6-pro', status: 200, ts: new Date(NOW - 49_000).toISOString(), tier: 'normal' },
    { alias: 'y', served: 'short', status: 200, ts: new Date(NOW - 49_000).toISOString(), tier: 'complex' },
  ]
  const r = rows(draw(data({ loop: loop(['a', 'b']), agents: [a, b], router: { routes, at: NOW } })))
  expect(r.find(l => /review-auto/.test(l))).not.toMatch(/complex/)
})

test('a failed task says so in the status column, not after the title', () => {
  const r = rows(draw(data({ loop: loop([], { failures: 1, state: 'fixing' }), agents: [] })))
  const row = r.find(l => /Task one/.test(l))!
  expect(row).toMatch(/─ ─ failed 1x\s*$/)
})

test('diff paths are shown relative to the project', () => {
  const a = agent({ id: 'a', type: 'code-auto', status: 'done', endedAt: NOW, hunks: [{ file: '/home/me/proj/src/x.ts', removed: ['a'], added: ['b'], omitted: 0, isNewFile: false }] })
  const r = rows(draw(data({ loop: loop(['a']), agents: [a], cwd: '/home/me/proj', view: { showAll: true, expanded: [], selected: 'agent:a' } })))
  expect(r.some(l => l.startsWith('src/x.ts') || / src\/x\.ts/.test(l))).toBe(true)
  expect(r.some(l => l.includes('/home/me/proj'))).toBe(false)
})

test('the detail opens under the selected row, before the next task', () => {
  const a = agent({ id: 'a', type: 'code-auto', status: 'done', endedAt: NOW, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, hunks: [{ file: '/p/x.ts', removed: ['a'], added: ['b'], omitted: 0, isNewFile: false }] })
  const r = rows(draw(data({ loop: loop(['a']), agents: [a], view: { showAll: true, expanded: [], selected: 'agent:a' } })))
  const detail = r.findIndex(l => /cache read/.test(l))
  const next = r.findIndex(l => /Task two/.test(l))
  expect(detail).toBeGreaterThan(-1)
  expect(detail).toBeLessThan(next)
})

test('while the router is unreachable, running reads as unconfirmed', () => {
  const a = agent({ id: 'a', type: 'code-auto', stepTimes: [NOW - 1000] })
  const tree = draw(data({ loop: loop(['a']), agents: [a], router: { routes: [], at: NOW - 30_000, error: 'router not reachable' } }))
  expect(colorOf(tree, 'running')).toBe('inactive')
})

test('only the running task title is bold', () => {
  const tree = draw(data({ loop: { ...loop([]), tasks: [{ id: '1', title: 'Lead', state: 'coding', failures: 0, agentIds: [] }, { id: '2', title: 'Later', state: 'pending', failures: 0, agentIds: [] }] } }))
  const boldOf = (needle: string) => { let b: boolean | undefined; const w = (n: any, bold?: boolean) => { if (typeof n === 'string') { if (n.includes(needle) && b === undefined) b = !!bold; return } if (n && typeof n === 'object') n.children.forEach((k: any) => w(k, n.props?.bold ?? bold)) }; w(tree); return b }
  expect(boldOf('Lead')).toBe(true)
  expect(boldOf('Later')).toBe(false)
})

test('a running agent does not wait for a router that has never answered', () => {
  const a = agent({ id: 'a', type: 'code-auto', stepTimes: [NOW - 1000] })
  const r = rows(draw(data({ loop: loop(['a']), agents: [a], router: { routes: [], error: 'router not reachable' } })))
  const row = r.find(l => /code-auto/.test(l))!
  expect(row).not.toMatch(/waiting for router/)
  expect(row).toMatch(/\?/)
})
