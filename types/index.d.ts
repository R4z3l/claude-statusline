export type Limit = { percent: number; resetsAt?: string }

export type Snapshot = {
  model: string
  ctxPercent?: number
  dir: string
  branch?: string
  isDirty: boolean
  ahead?: number
  behind?: number
  fiveHour?: Limit
  sevenDay?: Limit
}

declare module 'claude-code' {
  interface PluginState {
    'linia-statusu': {
      snap: Snapshot | null
    }
  }
}
