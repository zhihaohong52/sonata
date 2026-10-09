import type { AgentRow, Hunk, Loop, LoopTask, RouterState, View } from '../types'
import { attribute, childrenOf, depthOf, diffStat, taskCost } from './model'

export type PanelData = { loop: Loop | null; agents: AgentRow[]; router: RouterState; view: View; now: number }
export type PanelActions = {
  select: (key: string) => void
  toggleFold: (key: string) => void
  toggleActive: () => void
  jumpLatest: () => void
  copy: (text: string) => void
}

const MARK: Record<LoopTask['state'], string> = { pending: '·', coding: '▶', fixing: '▶', review: '◐', done: '✓' }
const AGENT_MARK: Record<AgentRow['status'], string> = { running: '▶', done: '✓', aborted: '■', error: '✗' }
const money = (usd: number): string => `$${usd.toFixed(2)}`
const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Every agent id in the trees rooted at `ids`, roots first. */
const treeIds = (agents: AgentRow[], ids: string[]): string[] =>
  ids.flatMap(id => [id, ...treeIds(agents, childrenOf(agents, id).map(c => c.id))])

/**
 * The pane's tree. Pure: `h` is the hooks module's JSX factory (a global there
 * only, so it is handed in), `els` the surface's element table and `act` the
 * press handlers the render hook built, so nothing here touches `$`.
 */
export function panelTree(h: any, els: any, data: PanelData, act: PanelActions) {
  const { Box, Text, Button } = els
  const { loop, agents, router, view, now } = data

  const modelCell = (a: AgentRow): string => {
    if (router.error !== undefined) return '?'
    const at = attribute(agents, router.routes, a.id)
    if (at.served.length === 0) return '?'
    return `${at.isExact ? '→' : '≈'} ${at.served.join('/')}${at.tier ? ` (${at.tier})` : ''}`
  }
  const tail = (a: AgentRow): string => {
    if (a.status === 'running') return `${a.activity ?? ''} · step ${a.steps} · ${clock(now - a.startedAt)}`
    const usd = attribute(agents, router.routes, a.id).usd
    return usd === undefined ? 'cost unknown' : money(usd)
  }

  const agentLines = (a: AgentRow): any[] => {
    if (!view.showAll && a.status !== 'running') return []
    const depth = depthOf(agents, a.id)
    const kids = childrenOf(agents, a.id)
    const notes = `${kids.length > 0 ? ` · fanned out ${kids.length}` : ''}${a.usedBash ? ' · Bash may have changed files: not shown' : ''}`
    const lines = [
      <Button key={`agent:${a.id}`} onPress={() => act.select(`agent:${a.id}`)}>
        <Text>{'  '.repeat(depth + 1)}{AGENT_MARK[a.status]} {a.type} "{a.description}" {modelCell(a)} <Text dimColor>{tail(a)}{notes}</Text></Text>
      </Button>,
    ]
    // Two levels in full; deeper descendants fold onto their ancestor's line.
    if (depth >= 1 && kids.length > 0 && !view.expanded.includes(`fold:${a.id}`)) {
      const hidden = treeIds(agents, kids.map(k => k.id)).length
      lines.push(
        <Button key={`fold:${a.id}`} onPress={() => act.toggleFold(`fold:${a.id}`)}>
          <Text dimColor>{'  '.repeat(depth + 2)}+{hidden} more (depth 3+)</Text>
        </Button>,
      )
      return lines
    }
    for (const k of kids) lines.push(...agentLines(k))
    return lines
  }

  const taskLines = (t: LoopTask): any[] => {
    const all = treeIds(agents, t.agentIds)
    const cost = taskCost(agents, router.routes, all)
    const stat = diffStat(all.flatMap(id => agents.find(a => a.id === id)?.hunks ?? []))
    const flag = t.escalatedTo ? ` escalated→${t.escalatedTo}` : t.failures > 0 ? ` failed ${t.failures}×` : ''
    const costText = all.length === 0 ? '—' : cost.isPartial ? `≈${money(cost.usd)} + unknown` : money(cost.usd)
    const top = t.agentIds.map(id => agents.find(a => a.id === id)).filter((a): a is AgentRow => a !== undefined)
    return [
      <Button key={`task:${t.id}`} onPress={() => act.select(`task:${t.id}`)}>
        <Text>{MARK[t.state]} {t.id} {t.title}<Text color="yellow">{flag}</Text> <Text dimColor>{costText}{stat.files > 0 ? ` · +${stat.added} −${stat.removed} · ${stat.files} files` : ''}</Text></Text>
      </Button>,
      ...top.flatMap(agentLines),
    ]
  }

  const selected = view.selected
  const hunks: Hunk[] = selected?.startsWith('agent:')
    ? agents.find(a => a.id === selected.slice('agent:'.length))?.hunks ?? []
    : selected?.startsWith('task:')
      ? treeIds(agents, loop?.tasks.find(t => t.id === selected.slice('task:'.length))?.agentIds ?? [])
        .flatMap(id => agents.find(a => a.id === id)?.hunks ?? [])
      : []
  const unplanned = agents.filter(a => a.parentId === undefined && a.taskId === undefined)
  const done = loop?.tasks.filter(t => t.state === 'done').length ?? 0

  return (
    <Box flexDirection="column">
      {loop === null && unplanned.length === 0 && <Text dimColor>No sonata loop running.</Text>}
      {loop !== null && (
        <Text bold>sonata loop · {loop.title} <Text dimColor>{done}/{loop.tasks.length} done · {clock(now - loop.startedAt)}{loop.isDone ? ' · finished' : ''}</Text></Text>
      )}
      <Box flexDirection="row">
        <Button key="toggle:active" onPress={() => act.toggleActive()}>{view.showAll ? 'active only' : 'all agents'}</Button>
        <Button key="jump:latest" onPress={() => act.jumpLatest()}>latest</Button>
      </Box>
      {loop?.tasks.flatMap(taskLines)}
      {unplanned.length > 0 && <Text dimColor>── Unplanned ──</Text>}
      {unplanned.flatMap(agentLines)}
      {hunks.length > 0 && <Text dimColor>── diff ({selected}) ──</Text>}
      {hunks.map((hunk, i) => (
        <Box key={`hunk:${i}`} flexDirection="column">
          <Button key={`copy:${i}`} onPress={() => act.copy([...hunk.removed.map(l => `- ${l}`), ...hunk.added.map(l => `+ ${l}`)].join('\n'))}>
            <Text bold>{hunk.file}{hunk.isNewFile ? ' (written)' : ''}</Text>
          </Button>
          {hunk.removed.map((l, j) => <Text key={`hunk:${i}:-${j}`} color="red">- {l}</Text>)}
          {hunk.added.map((l, j) => <Text key={`hunk:${i}:+${j}`} color="green">+ {l}</Text>)}
          {hunk.omitted > 0 && <Text dimColor>… {hunk.omitted} more lines</Text>}
        </Box>
      ))}
      {router.error !== undefined && <Text dimColor>{router.error}: models ?, costs unknown</Text>}
    </Box>
  )
}
