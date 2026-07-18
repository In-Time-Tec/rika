import { AgentTools } from "@rika/tools"
import { Function } from "effect"

const decodeParentExecutionId = (value: string) => {
  if (!value.startsWith("child:")) return undefined
  const separator = value.indexOf(":", "child:".length)
  if (separator < 0) return undefined
  try {
    return decodeURIComponent(value.slice("child:".length, separator))
  } catch {
    return undefined
  }
}

const childExecutionIdImpl = (parentExecutionId: string, childId: string) =>
  `child:${encodeURIComponent(parentExecutionId)}:${childId}`

export const childExecutionId: {
  (childId: string): (parentExecutionId: string) => string
  (parentExecutionId: string, childId: string): string
} = Function.dual(2, childExecutionIdImpl)

export const childExecutionDepth = (executionId: string) => {
  let depth = 0
  let current: string | undefined = executionId
  while (current !== undefined && depth < 64) {
    current = decodeParentExecutionId(current)
    if (current !== undefined) depth += 1
  }
  return depth
}

export const delegationAvailableAtDepth = (depth: number) => depth < 2

const toolsAtDepthImpl = (names: ReadonlyArray<string>, depth: number) =>
  delegationAvailableAtDepth(depth) ? [...names] : names.filter((name) => !AgentTools.isDelegationToolName(name))

export const toolsAtDepth: {
  (depth: number): (names: ReadonlyArray<string>) => Array<string>
  (names: ReadonlyArray<string>, depth: number): Array<string>
} = Function.dual(2, toolsAtDepthImpl)
