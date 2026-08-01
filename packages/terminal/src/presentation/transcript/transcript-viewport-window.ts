import { Function } from "effect"
import type { ViewportWindow } from "./transcript-window-state"

export const initialWindow = (total: number): ViewportWindow => ({ end: Math.max(0, total) })

export const windowStart: {
  (limit: number): (window: ViewportWindow) => number
  (window: ViewportWindow, limit: number): number
} = Function.dual(2, (window: ViewportWindow, limit: number): number => Math.max(0, window.end - limit))

export const atWindowTop: {
  (limit: number): (window: ViewportWindow) => boolean
  (window: ViewportWindow, limit: number): boolean
} = Function.dual(2, (window: ViewportWindow, limit: number): boolean => windowStart(window, limit) <= 0)

export const atWindowBottom: {
  (total: number): (window: ViewportWindow) => boolean
  (window: ViewportWindow, total: number): boolean
} = Function.dual(2, (window: ViewportWindow, total: number): boolean => window.end >= total)

export const advanceWindow: {
  (delta: number, total: number, limit: number): (window: ViewportWindow) => ViewportWindow
  (window: ViewportWindow, delta: number, total: number, limit: number): ViewportWindow
} = Function.dual(4, (window: ViewportWindow, delta: number, total: number, limit: number): ViewportWindow => {
  const minimumEnd = Math.min(limit, total)
  const end = Math.min(total, Math.max(minimumEnd, window.end + delta))
  return { end }
})

export const clampWindow: {
  (total: number, limit: number, pinned: boolean): (window: ViewportWindow) => ViewportWindow
  (window: ViewportWindow, total: number, limit: number, pinned: boolean): ViewportWindow
} = Function.dual(4, (window: ViewportWindow, total: number, limit: number, pinned: boolean): ViewportWindow => {
  if (pinned || window.end === 0) return { end: total }
  const minimumEnd = Math.min(limit, total)
  return { end: Math.min(total, Math.max(minimumEnd, window.end)) }
})

export interface TranscriptContentChange {
  readonly prepended: ReadonlyArray<string>
  readonly appended: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
}

export const classifyTranscriptContent: {
  (
    current: ReadonlyArray<{ readonly id: string }>,
  ): (previous: ReadonlyArray<{ readonly id: string }>) => TranscriptContentChange
  (
    previous: ReadonlyArray<{ readonly id: string }>,
    current: ReadonlyArray<{ readonly id: string }>,
  ): TranscriptContentChange
} = Function.dual(
  2,
  (
    previous: ReadonlyArray<{ readonly id: string }>,
    current: ReadonlyArray<{ readonly id: string }>,
  ): TranscriptContentChange => {
    const previousIds = new Set(previous.map(({ id }) => id))
    const currentIds = new Set(current.map(({ id }) => id))
    const retained = current.findIndex(({ id }) => previousIds.has(id))
    const lastRetained = current.findLastIndex(({ id }) => previousIds.has(id))
    return {
      prepended: (retained < 0 ? [] : current.slice(0, retained)).map(({ id }) => id),
      appended: (lastRetained < 0 ? current : current.slice(lastRetained + 1)).map(({ id }) => id),
      removed: previous.filter(({ id }) => !currentIds.has(id)).map(({ id }) => id),
    }
  },
)
