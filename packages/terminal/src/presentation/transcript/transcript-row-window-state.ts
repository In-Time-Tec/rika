export interface RowWindowState {
  readonly end: number
  readonly anchorKey?: string
  readonly pendingDelta: number
}

export const pinnedRowWindow: RowWindowState = { end: 0, pendingDelta: 0 }
export const isRowWindowPinned = (window: RowWindowState): boolean => window.end === 0
