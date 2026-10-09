import type { AgentRow, Hunk, Loop, LoopTask, Phase, Tier } from '../types'

const SONATA_AGENT = /^(native-)?(code|review|explore|plan)(-|$)/
export const isSonataAgent = (type: string): boolean => SONATA_AGENT.test(type)

const PHASES: readonly Phase[] = ['code', 'fix', 'review', 'final']
const TIERS: readonly Tier[] = ['simple', 'normal', 'complex']
const STATE_FOR: Record<Phase, LoopTask['state']> = { code: 'coding', fix: 'fixing', review: 'review', final: 'review' }

type Result = { loop: Loop | null } | { error: string }
const str = (v: unknown): v is string => typeof v === 'string' && v !== ''

export function applyLoopAction(loop: Loop | null, input: unknown, now: number): Result {
  const a = (input ?? {}) as Record<string, unknown>
  if (a.action === 'plan') {
    if (loop !== null && !loop.isDone) return { error: 'a loop is already running; call done first' }
    if (!str(a.title) || !Array.isArray(a.tasks)) return { error: 'plan needs title and tasks: [{ id, title }]' }
    const seen = new Set<string>()
    const tasks: LoopTask[] = []
    for (const t of a.tasks as Record<string, unknown>[]) {
      if (!str(t?.id) || !str(t?.title)) return { error: 'each task needs a string id and title' }
      if (seen.has(t.id)) return { error: `duplicate task id "${t.id}"` }
      seen.add(t.id)
      tasks.push({ id: t.id, title: t.title, state: 'pending', failures: 0, agentIds: [] })
    }
    return { loop: { title: a.title, tasks, isDone: false, startedAt: now } }
  }
  if (!['start', 'result', 'escalate', 'done'].includes(String(a.action))) {
    return { error: `unknown action "${String(a.action)}"; expected plan, start, result, escalate or done` }
  }
  if (loop === null || loop.isDone) return { error: 'no loop: call plan first' }
  if (a.action === 'done') return { loop: { ...loop, isDone: true, summary: str(a.summary) ? a.summary : undefined, pendingTaskId: undefined } }

  const task = loop.tasks.find(t => t.id === a.taskId)
  if (task === undefined) return { error: `unknown taskId "${String(a.taskId)}"; the plan has ${loop.tasks.map(t => t.id).join(', ')}` }
  const put = (next: LoopTask, extra: Partial<Loop> = {}): Result =>
    ({ loop: { ...loop, ...extra, tasks: loop.tasks.map(t => (t.id === next.id ? next : t)) } })

  if (a.action === 'start') {
    if (!PHASES.includes(a.phase as Phase)) return { error: 'phase must be code, fix, review or final' }
    const phase = a.phase as Phase
    return put({ ...task, state: STATE_FOR[phase], openPhase: phase }, { pendingTaskId: task.id })
  }
  if (a.action === 'result') {
    if (task.openPhase === undefined) return { error: `result for task "${task.id}" with no start before it` }
    if (a.outcome !== 'pass' && a.outcome !== 'fail') return { error: 'outcome must be pass or fail' }
    if (a.outcome === 'fail') return put({ ...task, failures: task.failures + 1, openPhase: undefined })
    const isReview = task.openPhase === 'review' || task.openPhase === 'final'
    return put({ ...task, state: isReview ? 'done' : task.state, openPhase: undefined })
  }
  if (!TIERS.includes(a.to as Tier)) return { error: 'to must be simple, normal or complex' }
  return put({ ...task, escalatedTo: a.to as Tier })
}

type Tracked = { loop: Loop | null; agents: AgentRow[] }

export function spawnAgent(
  s: Tracked,
  e: { agentId: string; subagentType: string; description: string; parentAgentId?: string },
  now: number,
): Tracked {
  if (!isSonataAgent(e.subagentType)) return s
  const parent = e.parentAgentId === undefined ? undefined : s.agents.find(a => a.id === e.parentAgentId)
  // A child belongs to its parent's task; only a top-level spawn takes the pending one.
  const taskId = e.parentAgentId !== undefined ? parent?.taskId : s.loop?.pendingTaskId
  const row: AgentRow = {
    id: e.agentId, type: e.subagentType, description: e.description, parentId: e.parentAgentId,
    taskId, status: 'running', steps: 0, stepTimes: [], usedBash: false, hunks: [], startedAt: now,
  }
  let loop = s.loop
  if (loop !== null && taskId !== undefined) {
    loop = {
      ...loop,
      pendingTaskId: e.parentAgentId === undefined ? undefined : loop.pendingTaskId,
      tasks: loop.tasks.map(t => (t.id === taskId ? { ...t, agentIds: [...t.agentIds, e.agentId] } : t)),
    }
  }
  return { loop, agents: [...s.agents, row] }
}

const patch = (agents: AgentRow[], id: string, fn: (a: AgentRow) => AgentRow): AgentRow[] =>
  agents.some(a => a.id === id) ? agents.map(a => (a.id === id ? fn(a) : a)) : agents

export const stepAgent = (agents: AgentRow[], e: { agentId: string; model: string }, now: number): AgentRow[] =>
  patch(agents, e.agentId, a => ({ ...a, steps: a.steps + 1, alias: e.model, stepTimes: [...a.stepTimes, now].slice(-200) }))

const base = (p: string): string => p.split('/').pop() ?? p

function describeCall(tool: string, input: Record<string, unknown>): string {
  const s = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const target = s('file_path') ? base(s('file_path')!)
    : s('pattern') ?? s('path') ?? (s('command')?.trim().split(/\s+/)[0]) ?? s('description')
  return target === undefined ? tool : `${tool} ${target}`
}

export const toolActivity = (agents: AgentRow[], e: { agentId: string; tool: string; input: Record<string, unknown> }): AgentRow[] =>
  patch(agents, e.agentId, a => ({ ...a, activity: describeCall(e.tool, e.input), usedBash: a.usedBash || e.tool === 'Bash' }))

export const completeAgent = (agents: AgentRow[], e: { agentId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }, now: number): AgentRow[] =>
  patch(agents, e.agentId, a => ({
    ...a, activity: undefined, endedAt: now,
    status: e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error',
  }))

export const childrenOf = (agents: AgentRow[], id: string | undefined): AgentRow[] =>
  agents.filter(a => a.parentId === id)

export function depthOf(agents: AgentRow[], id: string): number {
  let depth = 0
  let cur = agents.find(a => a.id === id)
  while (cur?.parentId !== undefined && depth < 32) {
    cur = agents.find(a => a.id === cur!.parentId)
    if (cur === undefined) break
    depth++
  }
  return depth
}

export const HUNK_LINES = 40
export const MAX_HUNKS = 30

function capped(file: string, removed: string[], added: string[], isNewFile: boolean): Hunk {
  // Removed lines first; added lines get the rest of the budget, or the whole
  // budget when removed used it all, so a big replacement still shows its new side.
  const keepRemoved = removed.slice(0, HUNK_LINES)
  const keepAdded = added.slice(0, Math.max(0, HUNK_LINES - keepRemoved.length) || HUNK_LINES)
  const omitted = removed.length - keepRemoved.length + added.length - keepAdded.length
  return { file, removed: keepRemoved, added: keepAdded, omitted, isNewFile }
}

export function hunksFor(tool: string, input: Record<string, unknown>): Hunk[] {
  const file = input.file_path
  if (typeof file !== 'string') return []
  if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return [capped(file, input.old_string.split('\n'), input.new_string.split('\n'), false)]
  }
  if (tool === 'Write' && typeof input.content === 'string') {
    return [capped(file, [], input.content.split('\n'), true)]
  }
  return []
}

export const addHunks = (agents: AgentRow[], agentId: string, hunks: Hunk[]): AgentRow[] =>
  hunks.length === 0 ? agents : patch(agents, agentId, a => ({ ...a, hunks: [...a.hunks, ...hunks].slice(-MAX_HUNKS) }))

export function diffStat(hunks: Hunk[]): { added: number; removed: number; files: number } {
  return {
    added: hunks.reduce((n, h) => n + h.added.length, 0),
    removed: hunks.reduce((n, h) => n + h.removed.length, 0),
    files: new Set(hunks.map(h => h.file)).size,
  }
}
