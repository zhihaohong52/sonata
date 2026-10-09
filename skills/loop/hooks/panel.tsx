import type { AgentRow, Hunk, Loop, LoopTask, RouterState, View } from '../types'
import { attribute, childrenOf, depthOf, diffStat, taskCost, totalTokens } from './model'

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
const STROKE = { running: '━━', done: '──', queued: '· ·', condition: '─ ─' } as const

const BAR_MIN_COLS = 76 // below this the cost bar goes first
const WORD_MIN_COLS = 56 // below this the status word goes; the stroke stands alone
const MODEL_MIN_COLS = 52 // below this an agent row drops its model column

const money = (usd: number): string => `$${usd.toFixed(usd < 1 ? 4 : 2)}`
const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}
/** A token count in 4 cells at most: 812, 9.4k, 41.5k, 1.2M. */
const tok = (n: number): string =>
  n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`
const ago = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s ago` : `${Math.round(ms / 60_000)}m ago`)
/** Cut to `n` cells, ending in `…` when cut (DESIGN.md: never truncate silently). */
const fit = (s: string, n: number): string => (n <= 0 ? '' : s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`)
/** Cut from the left, for paths: the file name is the part worth keeping. */
const fitLeft = (s: string, n: number): string => (s.length <= n ? s : `…${s.slice(s.length - n + 1)}`)
const padR = (s: string, n: number): string => fit(s, n).padEnd(Math.max(0, n))
const padL = (s: string, n: number): string => fit(s, n).padStart(Math.max(0, n))

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
  return { mark: STROKE.running, word: t.state, color: C.text }
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
 *
 * One line per task and per agent, on shared columns. Rows are `plain`
 * Buttons: no bracket chrome, and the surface's own focus inversion marks the
 * keyboard cursor. The accent edge marks the selection whose diff is open.
 */
export function panelTree(h: any, els: any, data: PanelData, act: PanelActions) {
  const { Box, Text, Button } = els
  const { loop, agents, router, view, now } = data
  const width = Math.max(40, Math.min(120, data.cols))
  const inner = width - 1 // the selection edge takes the first cell

  // ── the column budget, measured once for every row ──
  const statusW = width >= WORD_MIN_COLS ? 12 : 3
  const costW = 9
  const barW = width >= BAR_MIN_COLS ? 10 : 0
  const timeW = 6
  const stepsW = 4
  const tokW = 7
  const idW = 4
  const rule = '─'.repeat(width)

  const status = (s: Status) => (
    <Text color={s.color}>{padR(` ${s.mark}${statusW > 3 ? ` ${s.word}` : ''}`, statusW)}</Text>
  )

  // ── model cell: what the router actually served, or why it cannot say ──
  const modelOf = (a: AgentRow): { text: string; color: string } => {
    const at = attribute(agents, router.routes, a.id)
    if (at.served.length === 0) return { text: a.status === 'running' ? 'waiting for router' : '?', color: C.rule }
    const tier = at.tier ? ` · ${at.tier}` : ''
    return at.isExact
      ? { text: `→ ${at.served.join('/')}${tier}`, color: C.muted }
      : { text: `≈ ${at.served.join('/')}${tier}`, color: C.mid }
  }

  const selected = view.selected
  const isSel = (key: string) => selected === key
  const edge = (key: string) => <Text color={C.accent}>{isSel(key) ? '▌' : ' '}</Text>

  // ── agent rows: role, model, steps, time, state; activity only while running ──
  const agentLines = (a: AgentRow, indent: number): any[] => {
    const kids = childrenOf(agents, a.id)
    // A filtered-out parent still shows its running descendants.
    if (!view.showAll && a.status !== 'running') return kids.flatMap(k => agentLines(k, indent))
    const key = `agent:${a.id}`
    const depth = depthOf(agents, a.id)
    const pad = ' '.repeat(indent)
    const typeW = 16
    const restW = inner - indent - typeW - tokW - stepsW - timeW - statusW
    const showModel = width >= MODEL_MIN_COLS
    const model = modelOf(a)
    const elapsed = clock((a.endedAt ?? now) - a.startedAt)
    const lines = [
      <Button key={key} plain onPress={() => act.select(key)}>
        <Text>
          {edge(key)}
          <Text>{pad}</Text>
          <Text color={C.text} bold={isSel(key)}>{padR(a.type, showModel ? typeW : typeW + restW)}</Text>
          {showModel ? <Text color={model.color}>{padR(model.text.length > restW ? model.text.replace(/ · \S+$/, '') : model.text, restW)}</Text> : null}
          <Text color={a.tokens ? C.muted : C.rule}>{padL(a.tokens ? tok(totalTokens(a.tokens)) : '—', tokW)}</Text>
          <Text color={C.muted}>{padL(a.steps > 0 ? String(a.steps) : '', stepsW)}</Text>
          <Text color={C.muted}>{padL(elapsed, timeW)}</Text>
          {status(agentStatus(a))}
        </Text>
      </Button>,
    ]
    // The one detail line on the board: what a running agent is doing now.
    if (a.status === 'running') {
      const doing = [a.activity, a.description].filter(Boolean)[0] ?? ''
      lines.push(
        <Text key={`${key}:doing`} color={C.muted}>{` ${pad}  ${fit(doing, inner - indent - 2)}`}</Text>,
      )
    }
    // Two levels in full; deeper descendants fold onto their ancestor's line.
    if (depth >= 1 && kids.length > 0 && !view.expanded.includes(`fold:${a.id}`)) {
      const hidden = treeIds(agents, kids.map(k => k.id)).length
      lines.push(
        <Button key={`fold:${a.id}`} plain dimColor onPress={() => act.toggleFold(`fold:${a.id}`)}>
          {` ${pad}  +${hidden} more below`}
        </Button>,
      )
      return lines
    }
    for (const k of kids) lines.push(...agentLines(k, indent + 2))
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
    const filled = Math.round((usd / maxCost) * barW)
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
    const flag = t.escalatedTo ? ` →${t.escalatedTo} ` : t.failures > 0 ? ` failed ${t.failures}x ` : ''
    const titleW = inner - idW - flag.length - (barW ? barW + 1 : 0) - costW - statusW
    const costText = ids.length === 0 || (cost.isPartial && cost.usd === 0)
      ? '—'
      : `${cost.isPartial ? '≈' : ''}${money(cost.usd)}`
    const top = roots.map(id => agents.find(a => a.id === id)).filter((a): a is AgentRow => a !== undefined)
    return [
      <Box key={`${key}:gap`} height={i === 0 ? 0 : 1} />,
      <Button key={key} plain onPress={() => act.select(key)}>
        <Text>
          {edge(key)}
          <Text color={isLead ? C.accent : C.muted} bold={isLead}>{padL(t.id === 'final' ? 'end' : t.id, idW - 1)} </Text>
          <Text color={t.state === 'pending' ? C.muted : C.text} bold>{padR(t.title, titleW)}</Text>
          <Text color={C.mid}>{flag}</Text>
          {bar(cost.usd)}
          <Text color={costText === '—' ? C.rule : C.muted}>{padL(costText, costW)}</Text>
          {status(taskStatus(t))}
        </Text>
      </Button>,
      ...top.flatMap(a => agentLines(a, idW + 1)),
    ]
  }

  // ── the diff of what is selected ──
  const selAgent = selected?.startsWith('agent:') ? agents.find(a => a.id === selected.slice('agent:'.length)) : undefined
  const selTask = selected?.startsWith('task:') ? loop?.tasks.find(t => t.id === selected.slice('task:'.length)) : undefined
  const selIds = selAgent ? [selAgent.id] : selTask ? treeIds(agents, rootsOf(selTask, agents)) : []
  const hunks: Hunk[] = selAgent?.hunks ?? selIds.flatMap(id => agents.find(a => a.id === id)?.hunks ?? [])
  const usedBash = selIds.some(id => agents.find(a => a.id === id)?.usedBash)
  const diffLabel = selAgent ? `${selAgent.type}   ${selAgent.description}` : selTask ? `${selTask.id === 'final' ? 'end' : selTask.id}   ${selTask.title}` : ''
  const sel = diffStat(hunks)

  const unplanned = agents.filter(a => a.parentId === undefined && a.taskId === undefined)
  const done = loop?.tasks.filter(t => t.state === 'done').length ?? 0
  const loopCost = costs.reduce((n, c) => n + c.usd, 0)
  const loopPartial = costs.some(c => c.isPartial)
  const counted = agents.filter(a => a.tokens !== undefined)
  const loopTokens = counted.reduce((n, a) => n + totalTokens(a.tokens!), 0)
  const costNote = loop === null
    ? ''
    : loopCost === 0 && loopPartial ? 'cost unknown' : `${loopPartial ? '≈' : ''}${money(loopCost)}`

  const routerLine = router.error !== undefined
    ? {
        mark: STROKE.condition,
        color: C.mid,
        text: router.at !== undefined
          ? `${router.error} · showing what it reported ${ago(now - router.at)}`
          : `${router.error} · models ?, costs unknown`,
      }
    : router.at === undefined
      ? { mark: STROKE.queued, color: C.muted, text: 'router not read yet' }
      : { mark: STROKE.done, color: C.accent, text: `router up · updated ${ago(now - router.at)}` }

  // The head: the title, then the loop's facts right-aligned on the same line.
  const tokNote = counted.length === 0 ? '' : `${tok(loopTokens)} tok   `
  const facts = loop === null ? 'idle' : `${done} of ${loop.tasks.length} done   ${tokNote}${costNote}   ${clock(now - loop.startedAt)}`
  const title = loop === null ? '' : loop.title
  const titleRoom = Math.max(0, width - 6 - facts.length - 3)

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={C.text} bold>Loop</Text>
        <Text color={C.text}>{`  ${padR(title, titleRoom)}`}</Text>
        <Text color={C.muted}>{padL(facts, width - 6 - titleRoom)}</Text>
      </Text>
      <Text color={C.rule}>{rule}</Text>

      {loop === null && unplanned.length === 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={C.mid}>No loop running.</Text>
          <Text color={C.muted}>{fit('Run /sonata-loop <feature> to see it here.', width)}</Text>
        </Box>
      )}

      {loop !== null && <Box height={1} />}
      {loop?.tasks.flatMap(taskLines)}

      {unplanned.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={C.muted}>{'     unplanned'}</Text>
          {unplanned.flatMap(a => agentLines(a, idW + 1))}
        </Box>
      )}

      {loop?.isDone && loop.summary !== undefined && (
        <Box marginTop={1}><Text color={C.muted}>{fit(`     ${loop.summary}`, width)}</Text></Box>
      )}

      {selected !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={C.rule}>{rule}</Text>
          <Text>
            <Text color={C.text} bold>{fit(diffLabel, Math.max(10, width - 24))}</Text>
            <Text color={C.muted}>{hunks.length > 0 ? `   +${sel.added} −${sel.removed}   ${sel.files} file${sel.files === 1 ? '' : 's'}` : ''}</Text>
          </Text>
          {usedBash && <Text color={C.mid}>{fit('Bash ran here too. Edits it made are not in this diff.', width)}</Text>}
          {hunks.length === 0 && <Text color={C.muted}>no applied edits yet</Text>}
          {hunks.map((hunk, i) => (
            <Box key={`hunk:${i}`} flexDirection="column" marginTop={1}>
              <Button key={`copy:${i}`} plain onPress={() => act.copy([...hunk.removed.map(l => `- ${l}`), ...hunk.added.map(l => `+ ${l}`)].join('\n'))}>
                <Text>
                  <Text color={C.text} bold>{fitLeft(hunk.file, Math.max(10, width - 12))}</Text>
                  <Text color={C.muted}>{hunk.isNewFile ? '  written' : '  edited'}</Text>
                </Text>
              </Button>
              {hunk.removed.map((l, j) => <Text key={`hunk:${i}:-${j}`} color={C.text} backgroundColor="diffRemoved">{padR(`- ${l}`, width)}</Text>)}
              {hunk.added.map((l, j) => <Text key={`hunk:${i}:+${j}`} color={C.text} backgroundColor="diffAdded">{padR(`+ ${l}`, width)}</Text>)}
              {hunk.omitted > 0 && <Text color={C.muted}>{`  … ${hunk.omitted} more line${hunk.omitted === 1 ? '' : 's'}`}</Text>}
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}><Text color={C.rule}>{rule}</Text></Box>
      <Text>
        <Text color={routerLine.color}>{`${routerLine.mark} `}</Text>
        <Text color={C.muted}>{fit(routerLine.text, width - 4)}</Text>
      </Text>
      {(loop !== null || agents.length > 0) && <Box flexDirection="row">
        <Button key="toggle:active" plain dimColor hotkey="a" onPress={() => act.toggleActive()}>
          {view.showAll ? 'active only' : 'all agents'}
        </Button>
        <Text>{'   '}</Text>
        <Button key="jump:latest" plain dimColor hotkey="l" onPress={() => act.jumpLatest()}>latest</Button>
        {width >= 60 && <Text color={C.muted}>{'   enter: diff'}</Text>}
      </Box>}
    </Box>
  )
}
