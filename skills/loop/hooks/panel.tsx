import type { AgentRow, Loop, RouterState, View } from '../types'

export type PanelData = { loop: Loop | null; agents: AgentRow[]; router: RouterState; view: View; now: number }
export type PanelActions = {
  select: (key: string) => void
  toggleFold: (key: string) => void
  toggleActive: () => void
  jumpLatest: () => void
  copy: (text: string) => void
}

export function panelTree(els: any, _data: PanelData, _act: PanelActions) {
  const { Text } = els
  return <Text dimColor>sonata loop</Text>
}
