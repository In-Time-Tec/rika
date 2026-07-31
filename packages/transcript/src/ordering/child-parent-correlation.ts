import { ExecutionId } from "@rika/coding-tools/coding-tool-catalog"
import { Function } from "effect"
import type { Presentation } from "../schema/transcript-presentation-model"
import { decodeScopedIdentity } from "./transcript-unit-identity"

export const executionKey = ExecutionId.executionKey

const durableToolCallPrefix = /^rika:([^:]+):/

export const providerCallId = (id: string): string => {
  const match = durableToolCallPrefix.exec(id)
  if (match === null) return id
  try {
    const namespace = decodeURIComponent(match[1]!)
    return ExecutionId.isExecutionNamespace(namespace) ? id.slice(match[0].length) : id
  } catch {
    return id
  }
}

export const childScopeAndCallId = (
  childExecutionId: string,
): { readonly scope: string; readonly callId: string; readonly rawCallId: string } | undefined => {
  if (childExecutionId.startsWith("child:")) {
    const separator = childExecutionId.indexOf(":", "child:".length)
    if (separator < 0) return undefined
    try {
      const rawCallId = childExecutionId.slice(separator + 1)
      return {
        scope: executionKey(decodeURIComponent(childExecutionId.slice("child:".length, separator))),
        callId: providerCallId(rawCallId),
        rawCallId,
      }
    } catch {
      return undefined
    }
  }
  const key = executionKey(childExecutionId)
  const marker = ":child:"
  const index = key.lastIndexOf(marker)
  if (index < 0) return undefined
  const rawCallId = key.slice(index + marker.length)
  return { scope: key.slice(0, index), callId: providerCallId(rawCallId), rawCallId }
}

export interface ChildParentCandidate {
  readonly id: string
  readonly scope: string
  readonly childId: string | undefined
  readonly family: Presentation["family"]
}

export const candidateCallId = (candidate: ChildParentCandidate): string => {
  const scoped = decodeScopedIdentity(candidate.id)
  if (scoped !== undefined && executionKey(scoped.scope) === executionKey(candidate.scope))
    return providerCallId(scoped.id)
  const prefix = `${executionKey(candidate.scope)}:`
  const id = executionKey(candidate.id)
  return providerCallId(id.startsWith(prefix) ? id.slice(prefix.length) : id)
}

export const childParentMatch: {
  <A extends ChildParentCandidate>(candidates: Iterable<A>, childExecutionId: string): A | undefined
  (childExecutionId: string): <A extends ChildParentCandidate>(candidates: Iterable<A>) => A | undefined
} = Function.dual(
  2,
  <A extends ChildParentCandidate>(candidates: Iterable<A>, childExecutionId: string): A | undefined => {
    const childKey = executionKey(childExecutionId)
    const list = [...candidates]
    const linked = list.filter(
      (candidate) => candidate.childId !== undefined && executionKey(candidate.childId) === childKey,
    )
    const requesting = linked.find((candidate) => executionKey(candidate.id) !== childKey)
    if (requesting !== undefined) return requesting
    const parsed = childScopeAndCallId(childExecutionId)
    if (parsed !== undefined)
      for (const candidate of list)
        if (
          candidate.family === "agent" &&
          executionKey(candidate.scope) === parsed.scope &&
          candidateCallId(candidate) === parsed.callId
        )
          return candidate
    return linked[0]
  },
)
