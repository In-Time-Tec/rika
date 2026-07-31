export interface ExecutionActivity {
  readonly active: number
  readonly pending: number
  readonly reading: number
  readonly stopped: boolean
}

export const isProductExecutionQuiescent = (activity: ExecutionActivity): boolean =>
  activity.active === 0 && activity.pending === 0 && activity.reading === 0 && activity.stopped
