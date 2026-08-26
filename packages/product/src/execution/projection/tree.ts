export interface ProjectionTreeNode {
  readonly executionId: string
  readonly parentExecutionId?: string
}

export const projectionTreeRoots = (nodes: ReadonlyArray<ProjectionTreeNode>): ReadonlyArray<ProjectionTreeNode> => {
  const ids = new Set(nodes.map((node) => node.executionId))
  return nodes.filter((node) => node.parentExecutionId === undefined || !ids.has(node.parentExecutionId))
}
