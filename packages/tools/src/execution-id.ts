export const executionNamespacePrefixes = ["execution:", "child:", "workflow:"] as const

export const isExecutionNamespace = (value: string): boolean =>
  executionNamespacePrefixes.some((prefix) => value.startsWith(prefix))

export const executionKey = (value: string): string => value.replace(/^execution:/, "")
