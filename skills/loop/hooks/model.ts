import type { Loop, LoopTask, Phase, Tier } from '../types'

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
