import { Function } from "effect"
import { rowWindowStart, minimumRowEnd } from "./terminal-transcript-window"

export const includeRowEnd: {
  (end: number, index: number, total: number, limit: number): number
  (index: number, total: number, limit: number): (end: number) => number
} = Function.dual(4, (end: number, index: number, total: number, limit: number): number => {
  if (index < 0 || (index >= rowWindowStart(end, limit) && index < end)) return end
  return Math.min(total, Math.max(minimumRowEnd(total, limit), index + 1))
})
