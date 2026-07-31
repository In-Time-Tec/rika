export interface ChildProjectionFollow {
  readonly parentExecutionId: string
  readonly childExecutionId: string
}

export const childProjectionFollow = (parentExecutionId: string, childExecutionId: string): ChildProjectionFollow => ({
  parentExecutionId,
  childExecutionId,
})
