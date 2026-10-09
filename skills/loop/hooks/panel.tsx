import type { AgentRow, Hunk, Loop, LoopTask, RouterState, View } from '../types'
import { attribute, childrenOf, depthOf, diffStat, taskCost } from './model'

export type PanelData = {
  loop: Loop | null
  agents: AgentRow[]
  router: RouterState
  view: View
  now: number
  /** The pane's body width in cells. */
  cols: number
}
export type PanelActions = {
  select: (key: string) => void
  toggleFold: (key: string) => void
  toggleActive: () => void
  jumpLatest: () => void
  copy: (text: string) => void
}

// sonata's departure-board vocabulary (DESIGN.md), in Claude Code's own theme
// keys so the pane follows the host's light or dark theme. `claude` is the
// terracotta accent DESIGN.md already borrows: spent on the running task's
// numeral, the selection edge and the live router stroke, nothing else.
const C = { text: 'text', muted: 'inactive', rule: 'subtle', accent: 'claude', low: 'success', mid: 'warning', high: 'error' } as const

// The board's strokes. The mark carries the state; the word and colour only repeat it.
const STROKE = {
  running: '━━',
  done: '──',
  queued: '· ·',
  condition: '─ ─',
} as const

const COST_W = 9 // `≈$12.3456` fits; right-aligned, decimal-aligned
const ID_W = 4 // 3 right-aligned + a space
const BAR_MIN_COLS = 72 // below this the bar goes first
const WORD_MIN_COLS = 56 // below this the status word goes, the stroke stands alone

const money = (usd: number): string => `$${usd.toFixed(usd < 1 ? 4 : 2)}`
const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}
const ago = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s ago` : `${Math.round(ms / 60_000)}m ago`)
/** Cut to `n` cells, ending in `…` when cut (DESIGN.md: never truncate silently). */
const fit = (s: string, n: number): string => (n <= 0 ? '' : s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`)
/** Cut from the left, for paths: the file name is the part worth keeping. */
const fitLeft = (s: string, n: number): string => (s.length <= n ? s : `…${s.slice(s.length - n + 1)}`)
const padR = (s: string, n: number): string => fit(s, n).padEnd(n)
const padL = (s: string, n: number): string => fit(s, n).padStart(n)

/** Every agent id in the trees rooted at `ids`, roots first. */
const treeIds = (agents: AgentRow[], ids: string[]): string[] =>
  ids.flatMap(id => [id, ...treeIds(agents, childrenOf(agents, id).map(c => c.id))])

/**
 * A task's top-level agents. `agentIds` also lists the children its agents
 * spawned, so walking trees from all of them draws and counts a child twice.
 */
const rootsOf = (t: LoopTask, agents: AgentRow[]): string[] =>
  t.agentIds.filter(id => {
    const parent = agents.find(a => a.id === id)?.parentId
    return parent === undefined || !t.agentIds.includes(parent)
  })

type Status = { mark: string; word: string; color: string }

function taskStatus(t: LoopTask): Status {
  if (t.state === 'done') return { mark: STROKE.done, word: 'done', color: C.low }
  if (t.state === 'pending') return { mark: STROKE.queued, word: 'queued', color: C.muted }
  const word = t.state === 'review' ? 'review' : t.state
  return { mark: STROKE.running, word, color: C.text }
}

function agentStatus(a: AgentRow): Status {
  if (a.status === 'running') return { mark: STROKE.running, word: 'running', color: C.text }
  if (a.status === 'done') return { mark: STROKE.done, word: 'done', color: C.low }
  if (a.status === 'aborted') return { mark: STROKE.condition, word: 'stopped', color: C.mid }
  return { mark: STROKE.condition, word: 'failed', color: C.high }
}

/**
 * The pane's tree. Pure: `h` is the hooks module's JSX factory (a global there
 * only, so it is handed in), `els` the surface's element table and `act` the
 * press handlers the render hook built, so nothing here touches `$`.
 */
export function panelTree(h: any, els: any, data: PanelData, act: PanelActions) {
  const { Box, Text, Button } = els
  const { loop, agents, router, view, now } = data
  const width = Math.max(40, Math.min(120, data.cols))
  const withWord = width >= WORD_MIN_COLS
  const statusW = withWord ? 13 : 4
  const barW = width >= BAR_MIN_COLS ? Math.min(12, Math.max(6, Math.floor(width * 0.12))) : 0
  const rule = '─'.repeat(width)

  const status = (s: Status) => (
    <Text color={s.color}>{padR(` ${s.mark}${withWord ? ` ${s.word}` : ''}`, statusW)}</Text>
  )
  const costCell = (usd: number | undefined, partial = false) => (
    <Text color={usd === undefined ? C.rule : C.muted}>
      {padL(usd === undefined ? '—' : `${partial ? '≈' : ''}${money(usd)}`, COST_W)}
    </Text>
  )

  // ── model cell: what the router actually served, or why it cannot say ──
  const modelOf = (a: AgentRow): { text: string; color: string } => {
    if (router.error !== undefined) return { text: '?', color: C.mid }
    const at = attribute(agents, router.routes, a.id)
    if (at.served.length === 0) return { text: a.status === 'running' ? 'waiting for router' : '?', color: C.rule }
    const tier = at.tier ? ` · ${at.tier}` : ''
    return at.isExact
      ? { text: `→ ${at.served.join('/')}${tier}`, color: C.muted }
      : { text: `≈ ${at.served.join('/')}${tier}`, color: C.mid }
  }

  const selected = view.selected
  const isSel = (key: string) => selected === key
  // Selection is drawn two ways at once: the accent edge and full-weight text.
  const edge = (key: string) => <Text color={C.accent}>{isSel(key) ? '▌' : ' '}</Text>

  // ── agent rows: a box-drawing tree under the task, activity on a second line ──
  const agentLines = (a: AgentRow, isLast: boolean, prefix: string): any[] => {
    const kids = childrenOf(agents, a.id)
    // A filtered-out parent still shows its running descendants.
    if (!view.showAll && a.status !== 'running') {
      return kids.flatMap((k, i) => agentLines(k, i === kids.length - 1, prefix))
    }
    const key = `agent:${a.id}`
    const depth = depthOf(agents, a.id)
    const branch = `${prefix}${isLast ? '└─ ' : '├─ '}`
    const model = modelOf(a)
    const at = attribute(agents, router.routes, a.id)
    const nameW = Math.max(8, width - 1 - branch.length - COST_W - statusW - 1)
    const label = `${a.type}  ${a.description}`
    const lines = [
      <Button key={key} onPress={() => act.select(key)}>
        <Text>
          {edge(key)}
          <Text color={C.rule}>{branch}</Text>
          <Text color={C.text} bold={isSel(key)}>{padR(label, nameW)}</Text>
          <Text> </Text>
          {costCell(a.status === 'running' ? undefined : at.usd)}
          {status(agentStatus(a))}
        </Text>
      </Button>,
    ]
    // The detail line: which model served it, and what it is doing now.
    const cont = `${prefix}${isLast ? '   ' : '│  '}`
    const doing = a.status === 'running'
      ? [a.activity, `step ${a.steps}`, clock(now - a.startedAt)].filter(Boolean).join(' · ')
      : [a.steps > 0 ? `${a.steps} steps` : undefined, a.endedAt ? clock(a.endedAt - a.startedAt) : undefined].filter(Boolean).join(' · ')
    const stat = diffStat(a.hunks)
    const extras = [
      stat.files > 0 ? `+${stat.added} −${stat.removed}` : undefined,
      kids.length > 0 ? `fanned out ${kids.length}` : undefined,
    ].filter(Boolean).join(' · ')
    lines.push(
      <Box key={`${key}:detail`} flexDirection="row">
        <Text> </Text>
        <Text color={C.rule}>{cont}   </Text>
        <Text color={model.color}>{fit(model.text, Math.max(8, Math.floor((width - cont.length - 4) / 2)))}</Text>
        <Text color={C.muted}>{fit(`${doing ? `   ${doing}` : ''}${extras ? ` · ${extras}` : ''}`, Math.max(0, width - cont.length - 4 - model.text.length))}</Text>
      </Box>,
    )
    if (a.usedBash) {
      lines.push(
        <Text key={`${key}:bash`} color={C.mid}>{` ${cont}   ${fit('Bash ran: edits it made are not in the diff', width - cont.length - 4)}`}</Text>,
      )
    }
    // Two levels in full; deeper descendants fold onto their ancestor's line.
    if (depth >= 1 && kids.length > 0 && !view.expanded.includes(`fold:${a.id}`)) {
      const hidden = treeIds(agents, kids.map(k => k.id)).length
      lines.push(
        <Button key={`fold:${a.id}`} onPress={() => act.toggleFold(`fold:${a.id}`)}>
          <Text color={C.muted}>{` ${cont}└─ +${hidden} more below`}</Text>
        </Button>,
      )
      return lines
    }
    kids.forEach((k, i) => lines.push(...agentLines(k, i === kids.length - 1, cont)))
    return lines
  }

  // ── task rows: id, title, share-of-spend bar, cost, state stroke ──
  const costs = (loop?.tasks ?? []).map(t => taskCost(agents, router.routes, treeIds(agents, rootsOf(t, agents))))
  const maxCost = Math.max(0, ...costs.map(c => c.usd))
  const running = loop?.tasks.find(t => t.state !== 'done' && t.state !== 'pending')

  const bar = (usd: number) => {
    if (barW === 0) return null
    // Nothing priced yet: an empty track would read as a measurement of zero.
    if (maxCost === 0) return <Text>{' '.repeat(barW + 1)}</Text>
    const filled = maxCost > 0 ? Math.round((usd / maxCost) * barW) : 0
    return (
      <Text>
        <Text color={C.low}>{'━'.repeat(filled)}</Text>
        <Text color={C.rule}>{'─'.repeat(barW - filled)}</Text>
        <Text> </Text>
      </Text>
    )
  }

  const taskLines = (t: LoopTask, i: number): any[] => {
    const key = `task:${t.id}`
    const roots = rootsOf(t, agents)
    const ids = treeIds(agents, roots)
    const cost = costs[i]
    const isLead = running?.id === t.id
    const flag = t.escalatedTo ? `  →${t.escalatedTo}` : t.failures > 0 ? `  failed ${t.failures}×` : ''
    const titleW = Math.max(8, width - 1 - ID_W - (barW ? barW + 1 : 0) - COST_W - statusW - flag.length - 1)
    const top = roots.map(id => agents.find(a => a.id === id)).filter((a): a is AgentRow => a !== undefined)
    const shown = top.filter(a => view.showAll || a.status === 'running' || treeIds(agents, [a.id]).some(id => agents.find(x => x.id === id)?.status === 'running'))
    return [
      <Button key={key} onPress={() => act.select(key)}>
        <Text>
          {edge(key)}
          <Text color={isLead ? C.accent : C.muted} bold={isLead}>{padL(t.id === 'final' ? 'end' : t.id, ID_W - 1)} </Text>
          <Text color={t.state === 'pending' ? C.muted : C.text} bold={isLead || isSel(key)}>{padR(t.title, titleW)}</Text>
          <Text color={C.mid}>{flag}</Text>
          <Text> </Text>
          {bar(cost.usd)}
          {costCell(ids.length === 0 ? undefined : cost.isPartial && cost.usd === 0 ? undefined : cost.usd, cost.isPartial)}
          {status(taskStatus(t))}
        </Text>
      </Button>,
      ...shown.flatMap((a, j) => agentLines(a, j === shown.length - 1, '    ')),
    ]
  }

  // ── the diff of what is selected ──
  const selAgent = selected?.startsWith('agent:') ? agents.find(a => a.id === selected.slice('agent:'.length)) : undefined
  const selTask = selected?.startsWith('task:') ? loop?.tasks.find(t => t.id === selected.slice('task:'.length)) : undefined
  const hunks: Hunk[] = selAgent?.hunks
    ?? (selTask ? treeIds(agents, rootsOf(selTask, agents)).flatMap(id => agents.find(a => a.id === id)?.hunks ?? []) : [])
  const diffLabel = selAgent ? `${selAgent.type}  ${selAgent.description}` : selTask ? `${selTask.id}  ${selTask.title}` : ''
  const sel = diffStat(hunks)

  const unplanned = agents.filter(a => a.parentId === undefined && a.taskId === undefined)
  const done = loop?.tasks.filter(t => t.state === 'done').length ?? 0
  const loopCost = costs.reduce((n, c) => n + c.usd, 0)
  const loopPartial = costs.some(c => c.isPartial)

  const headNote = loop === null
    ? 'idle'
    : [
        loop.title,
        `${done} of ${loop.tasks.length} done`,
        loopCost === 0 && loopPartial ? 'cost unknown' : loopPartial ? `≈${money(loopCost)} + unknown` : money(loopCost),
        clock(now - loop.startedAt),
        loop.isDone ? 'finished' : undefined,
      ].filter(Boolean).join(' · ')

  const routerLine = router.error !== undefined
    ? { mark: STROKE.condition, color: C.mid, text: `${router.error} · models ?, costs unknown` }
    : router.at === undefined
      ? { mark: STROKE.queued, color: C.muted, text: 'router not read yet' }
      : { mark: STROKE.done, color: C.accent, text: `router up · updated ${ago(now - router.at)}` }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={C.text} bold>Loop</Text>
        <Text color={C.muted}>{fit(`   ${headNote}`, width - 4)}</Text>
      </Box>
      <Text color={C.rule}>{rule}</Text>

      {loop === null && unplanned.length === 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={C.mid}>No loop yet.</Text>
          <Text color={C.muted}>{fit('Run /sonata-loop <feature>: its plan, agents and diffs appear here.', width)}</Text>
        </Box>
      )}

      {loop?.tasks.flatMap(taskLines)}

      {unplanned.length > 0 && (
        <Box flexDirection="column" marginTop={loop === null ? 0 : 1}>
          <Text color={C.muted}>{'    unplanned'}</Text>
          {unplanned.flatMap((a, j) => agentLines(a, j === unplanned.length - 1, '    '))}
        </Box>
      )}

      {loop?.isDone && loop.summary !== undefined && (
        <Box marginTop={1}><Text color={C.muted}>{fit(`    ${loop.summary}`, width)}</Text></Box>
      )}

      {selected !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Text color={C.text} bold>{fit(`diff  ${diffLabel}`, Math.max(10, width - 22))}</Text>
            <Text color={C.muted}>{hunks.length > 0 ? `   +${sel.added} −${sel.removed} · ${sel.files} file${sel.files === 1 ? '' : 's'}` : ''}</Text>
          </Box>
          {hunks.length === 0 && <Text color={C.muted}>{'    no applied edits yet'}</Text>}
          {hunks.map((hunk, i) => (
            <Box key={`hunk:${i}`} flexDirection="column" marginTop={1}>
              <Button key={`copy:${i}`} onPress={() => act.copy([...hunk.removed.map(l => `- ${l}`), ...hunk.added.map(l => `+ ${l}`)].join('\n'))}>
                <Text>
                  <Text color={C.text} bold>{fitLeft(hunk.file, Math.max(10, width - 16))}</Text>
                  <Text color={C.muted}>{hunk.isNewFile ? '  written' : '  edited'}</Text>
                </Text>
              </Button>
              {hunk.removed.map((l, j) => <Text key={`hunk:${i}:-${j}`} color={C.text} backgroundColor="diffRemoved">{fit(`- ${l}`, width).padEnd(width)}</Text>)}
              {hunk.added.map((l, j) => <Text key={`hunk:${i}:+${j}`} color={C.text} backgroundColor="diffAdded">{fit(`+ ${l}`, width).padEnd(width)}</Text>)}
              {hunk.omitted > 0 && <Text color={C.muted}>{`  … ${hunk.omitted} more line${hunk.omitted === 1 ? '' : 's'}`}</Text>}
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}><Text color={C.rule}>{rule}</Text></Box>
      <Box flexDirection="row">
        <Text color={routerLine.color}>{`${routerLine.mark} `}</Text>
        <Text color={C.muted}>{fit(routerLine.text, width - 4)}</Text>
      </Box>
      <Box flexDirection="row">
        <Button key="toggle:active" hotkey="a" onPress={() => act.toggleActive()}>
          <Text color={C.muted}>{`a ${view.showAll ? 'active only' : 'all agents'}`}</Text>
        </Button>
        <Text>{'   '}</Text>
        <Button key="jump:latest" hotkey="l" onPress={() => act.jumpLatest()}>
          <Text color={C.muted}>l latest</Text>
        </Button>
        {/* Key-then-verb pairs drop from the end rather than wrap. */}
        <Text color={C.muted}>{['   enter diff', '   ctrl+x tab focus'].reduce((acc, pair) => (24 + acc.length + pair.length <= width ? acc + pair : acc), '')}</Text>
      </Box>
    </Box>
  )
}
