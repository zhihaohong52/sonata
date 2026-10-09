export type Tier = 'simple' | 'normal' | 'complex'
export type Phase = 'code' | 'fix' | 'review' | 'final'
export type TaskState = 'pending' | 'coding' | 'fixing' | 'review' | 'done'

export type LoopTask = {
  id: string
  title: string
  state: TaskState
  failures: number
  escalatedTo?: Tier
  /** The phase of the last `start`, until its `result`. */
  openPhase?: Phase
  agentIds: string[]
}

export type Loop = {
  title: string
  tasks: LoopTask[]
  /** Set by `start`; the next top-level sonata spawn attaches here. */
  pendingTaskId?: string
  isDone: boolean
  summary?: string
  startedAt: number
}

export type AgentStatus = 'running' | 'done' | 'aborted' | 'error'

export type Hunk = {
  file: string
  removed: string[]
  added: string[]
  /** Lines cut by the 40-line cap. */
  omitted: number
  isNewFile: boolean
}

export type AgentRow = {
  id: string
  type: string
  description: string
  parentId?: string
  taskId?: string
  status: AgentStatus
  activity?: string
  steps: number
  /** The model alias its requests name (`sonata-code-auto`). */
  alias?: string
  /** Epoch ms of each `turn.step`, for matching router routes. */
  stepTimes: number[]
  usedBash: boolean
  /** Summed from each step's reported usage; absent until one reports. */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  hunks: Hunk[]
  startedAt: number
  endedAt?: number
}

export type RouteLine = {
  alias: string
  served?: string
  status: number
  ts?: string
  role?: string
  tier?: string
  priceUsd?: number
}

export type RouterState = {
  routes: RouteLine[]
  error?: string
  /** When the router was last read successfully (epoch ms). */
  at?: number
}

export type View = { selected?: string; showAll: boolean; expanded: string[] }

declare module 'claude-code' {
  interface PluginState {
    'sonata-loop': {
      loop: Loop | null
      agents: AgentRow[]
      router: RouterState
      view: View
    }
  }
}
