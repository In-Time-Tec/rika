import * as ExecutionBackend from "../../execution/contract/execution-service"
import { ExecutionId } from "../../execution/contract/execution-identifier"
import { Function } from "effect"

export interface RootExecutionEvent {
  readonly executionId: string
  readonly sequence: number
  readonly terminal: boolean
}

export const isRootExecutionEvent = (event: RootExecutionEvent): boolean => event.executionId.length > 0

export const rootExecutionEvents: {
  (turnId: string, events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event>
  (events: ReadonlyArray<ExecutionBackend.Event>): (turnId: string) => ReadonlyArray<ExecutionBackend.Event>
} = Function.dual(
  2,
  (turnId: string, events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event> =>
    events.filter((event) => ExecutionId.ownsExecution(turnId, event.executionId)),
)
