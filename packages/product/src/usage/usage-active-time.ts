export interface ActiveTimeWindow {
  readonly startedAt: number
  readonly endedAt: number
}

export const activeMillis = (window: ActiveTimeWindow): number => Math.max(0, window.endedAt - window.startedAt)
