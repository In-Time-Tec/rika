import * as ExecutionEvent from "@rika/product/execution-event"
import { ExecutionId } from "../../execution/contract/execution-identifier"
import { Function } from "effect"

export interface RootExecutionEvent {
  readonly executionId: string
  readonly sequence: number
  readonly terminal: boolean
}

export const isRootExecutionEvent = (event: RootExecutionEvent): boolean => event.executionId.length > 0

export const rootExecutionEvents: {
  (turnId: string, events: ReadonlyArray<ExecutionEvent.Event>): ReadonlyArray<ExecutionEvent.Event>
  (events: ReadonlyArray<ExecutionEvent.Event>): (turnId: string) => ReadonlyArray<ExecutionEvent.Event>
} = Function.dual(
  2,
  (turnId: string, events: ReadonlyArray<ExecutionEvent.Event>): ReadonlyArray<ExecutionEvent.Event> =>
    events.filter((event) => ExecutionId.ownsExecution(turnId, event.executionId)),
)
