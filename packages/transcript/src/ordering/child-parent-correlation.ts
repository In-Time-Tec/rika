import { Function } from "effect"
import type { Presentation } from "../schema/transcript-presentation-model"

export const executionKey = (value: string): string => value

export interface ChildParentCandidate {
  readonly id: string
  readonly scope: string
  readonly childId: string | undefined
  readonly family: Presentation["family"]
}

export const childParentMatch: {
  <A extends ChildParentCandidate>(candidates: Iterable<A>, childExecutionId: string): A | undefined
  (childExecutionId: string): <A extends ChildParentCandidate>(candidates: Iterable<A>) => A | undefined
} = Function.dual(
  2,
  <A extends ChildParentCandidate>(candidates: Iterable<A>, childExecutionId: string): A | undefined => {
    const linked = [...candidates].filter((candidate) => candidate.childId === childExecutionId)
    const requesting = linked.find((candidate) => candidate.id !== childExecutionId)
    if (requesting !== undefined) return requesting
    return linked[0]
  },
)
