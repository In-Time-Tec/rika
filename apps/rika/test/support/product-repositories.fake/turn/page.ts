import { Turn } from "@rika/product/turn-record"

import { Schema } from "effect"
import { PageCursor as PageCursorSchema, defaultPageSize, maximumPageSize } from "@rika/product/turn-repository"
type PageCursor = typeof PageCursorSchema.Type

export const clone = <T extends Turn>(turn: T): T => structuredClone(turn)
const turnEquivalence = Schema.toEquivalence(Turn)

function sameTurnImplementation(left: Turn, right: Turn): boolean
function sameTurnImplementation(right: Turn): (left: Turn) => boolean
function sameTurnImplementation(leftOrRight: Turn, right?: Turn): boolean | ((left: Turn) => boolean) {
  if (right === undefined) return (left) => sameTurnImplementation(left, leftOrRight)
  return turnEquivalence(leftOrRight, right)
}

export const sameTurn: {
  (left: Turn, right: Turn): boolean
  (right: Turn): (left: Turn) => boolean
} = sameTurnImplementation
export const pageSize = (limit: number | undefined) =>
  Math.min(maximumPageSize, Math.max(1, Math.floor(limit ?? defaultPageSize)))
export const cursorFor = (turn: Turn | undefined): PageCursor | undefined =>
  turn === undefined ? undefined : { createdAt: turn.createdAt, id: turn.id }
