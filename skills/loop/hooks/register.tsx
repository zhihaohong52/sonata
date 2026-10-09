import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { AgentRow, Loop, RouterState, View } from '../types'
import { addHunks, applyLoopAction, completeAgent, hunksFor, spawnAgent, stepAgent, toolActivity } from './model'
import { panelTree } from './panel'
import type { PanelActions, PanelData } from './panel'

const PLUGIN = 'sonata-loop'
const PANE = 'sonata-loop'

export const loopAtom = atom({ plugin: 'sonata-loop', key: 'loop' } as const, null as Loop | null)
export const agentsAtom = atom({ plugin: 'sonata-loop', key: 'agents' } as const, [] as AgentRow[])
export const routerAtom = atom({ plugin: 'sonata-loop', key: 'router' } as const, { routes: [] } as RouterState)
export const viewAtom = atom({ plugin: 'sonata-loop', key: 'view' } as const, { showAll: true, expanded: [] } as View)

const TOOL_DESCRIPTION = [
  'Report sonata-loop progress to the loop panel. Call it at each loop step:',
  'plan {title, tasks:[{id,title}]} after planning; start {taskId, phase: code|fix|review|final}',
  'right before each dispatch; result {taskId, outcome: pass|fail, note?} after each review;',
  'escalate {taskId, to: simple|normal|complex}; done {summary?} at the end.',
].join(' ')

// The keys tool.call carries beside a tool's own arguments.
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])
const argsOf = (e: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))

// Module state: reset on reload, which is fine — a poll restarts on the next spawn.
let routerUrl = 'http://127.0.0.1:4100'
let polling = false

// Polls the router's view of this session while any agent runs; stops by itself.
async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    while ((await read($, agentsAtom)).some(a => a.status === 'running')) {
      try {
        const session = await $.session.id()
        const res = await $.http.fetch(`${routerUrl}/__sonata/api/session/${encodeURIComponent(session)}`)
        const body = res.ok ? (JSON.parse(res.text) as { routes?: RouterState['routes'] }) : undefined
        await update($, routerAtom, () => (body?.routes === undefined
          ? { routes: [], error: `router answered ${res.status}` }
          : { routes: body.routes }))
      } catch {
        await update($, routerAtom, r => ({ ...r, error: 'router not reachable' }))
      }
      await $.clock.sleep(3_000)
    }
  } finally {
    polling = false
  }
}

export const register: Register = (on, options) => {
  routerUrl = String((options as { router_url?: unknown } | undefined)?.router_url ?? 'http://127.0.0.1:4100')
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'sonata_loop',
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { enum: ['plan', 'start', 'result', 'escalate', 'done'] },
          title: { type: 'string' }, taskId: { type: 'string' }, summary: { type: 'string' }, note: { type: 'string' },
          phase: { enum: ['code', 'fix', 'review', 'final'] }, outcome: { enum: ['pass', 'fail'] },
          to: { enum: ['simple', 'normal', 'complex'] },
          tasks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] } },
        },
        required: ['action'],
      },
    })
    await $.command.register({ name: 'sonata-loop', description: 'Show or hide the sonata loop panel' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, loopAtom, () => null)
      await update($, agentsAtom, () => [])
      await update($, viewAtom, () => ({ showAll: true, expanded: [] }))
    }
    return next(e)
  })

  on('command.run', { command: 'sonata-loop' }, async $ => {
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: 'sonata loop' })
    return { text: isOpen ? 'Loop panel closed.' : 'Loop panel opened.' }
  })

  // The mod's own tool: the one place a refusal is allowed (validation only).
  on('tool.call', { tool: 'mcp__sonata-loop__sonata_loop' }, async ($, e) => {
    const input = argsOf(e)
    const result = applyLoopAction(await read($, loopAtom), input, Date.now())
    if ('error' in result) return { deny: result.error }
    await update($, loopAtom, () => result.loop)
    if (input.action === 'plan') void $.ui.open({ id: PANE, title: 'sonata loop' })
    const n = result.loop?.tasks.length ?? 0
    return { result: { ok: true }, text: `sonata_loop recorded (${n} task${n === 1 ? '' : 's'}).` }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if ('agentId' in started && started.agentId !== undefined) {
      const s = spawnAgent(
        { loop: await read($, loopAtom), agents: await read($, agentsAtom) },
        { agentId: started.agentId, subagentType: e.subagentType, description: e.description, parentAgentId: e.parentAgentId },
        Date.now(),
      )
      await update($, loopAtom, () => s.loop)
      await update($, agentsAtom, () => s.agents)
      void poll($)
    }
    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await update($, agentsAtom, a => stepAgent(a, { agentId, model: e.model }, Date.now()))
    }
    return yield* next(e)
  })

  // Every other tool call: observe the subagent's activity and its applied edits.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const input = argsOf(e)
    if (agentId !== undefined) await update($, agentsAtom, a => toolActivity(a, { agentId, tool: e.tool, input }))
    const ran = await next(e)
    if (agentId !== undefined && !('deny' in ran && ran.deny !== undefined) && ran.isError !== true) {
      const hunks = hunksFor(e.tool, input)
      if (hunks.length > 0) await update($, agentsAtom, a => addHunks(a, agentId, hunks))
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await update($, agentsAtom, a => completeAgent(a, { agentId, reason: e.reason }, Date.now()))
    }
    return next(e)
  })

  // $ never crosses an import, so the hook gathers the data and the press
  // handlers here and panel.tsx only arranges them.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const data: PanelData = {
      loop: await read($, loopAtom),
      agents: await read($, agentsAtom),
      router: await read($, routerAtom),
      view: await read($, viewAtom),
      now: Date.now(),
    }
    const act: PanelActions = {
      select: key => void update($, viewAtom, v => ({ ...v, selected: v.selected === key ? undefined : key })),
      toggleFold: key => void update($, viewAtom, v => ({
        ...v, expanded: v.expanded.includes(key) ? v.expanded.filter(k => k !== key) : [...v.expanded, key],
      })),
      toggleActive: () => void update($, viewAtom, v => ({ ...v, showAll: !v.showAll })),
      jumpLatest: () => void $.ui.scroll({ in: PANE, to: 'end' }),
      copy: text => void $.ui.copy({ text }),
    }
    return panelTree(h, $.ui.resolve(e), data, act)
  })
}
