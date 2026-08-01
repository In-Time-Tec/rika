import { Function } from "effect"
export interface ChildProjectionFollow {
  readonly parentExecutionId: string
  readonly childExecutionId: string
}

const childProjectionFollowImpl = (parentExecutionId: string, childExecutionId: string): ChildProjectionFollow => ({
  parentExecutionId,
  childExecutionId,
})

export const childProjectionFollow: {
  (arg1: string): (arg0: string) => ReturnType<typeof childProjectionFollowImpl>
  (arg0: string, arg1: string): ReturnType<typeof childProjectionFollowImpl>
} = Function.dual(2, childProjectionFollowImpl)
