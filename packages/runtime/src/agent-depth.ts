import { AgentTools } from "@rika/tools"
import { Function } from "effect"

export const decodeParentExecutionId = (value: string) => {
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

export const delegationAvailableAtDepth = (name: AgentTools.DelegationToolName, depth: number) =>
  depth === 0 || (depth === 1 && name !== "task")

const toolsAtDepthImpl = (names: ReadonlyArray<string>, depth: number) =>
  names.filter((name) => {
    if (AgentTools.isDelegationToolName(name)) return delegationAvailableAtDepth(name, depth)
    if (name === AgentTools.awaitSubagentsToolName) return depth < 2
    return true
  })

export const toolsAtDepth: {
  (depth: number): (names: ReadonlyArray<string>) => Array<string>
  (names: ReadonlyArray<string>, depth: number): Array<string>
} = Function.dual(2, toolsAtDepthImpl)
