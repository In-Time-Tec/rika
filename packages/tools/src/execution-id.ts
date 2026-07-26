import { Function } from "effect"

export const executionNamespacePrefixes = ["execution:", "child:", "workflow:"] as const

export const isExecutionNamespace = (value: string): boolean =>
  executionNamespacePrefixes.some((prefix) => value.startsWith(prefix))

export const executionKey = (value: string): string => value.replace(/^execution:/, "")

export const ownsExecution: {
  (turnId: string, executionId: string): boolean
  (executionId: string): (turnId: string) => boolean
} = Function.dual(2, (turnId: string, executionId: string): boolean => executionKey(executionId) === turnId)
