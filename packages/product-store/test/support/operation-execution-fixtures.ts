import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as TurnContract from "@rika/product/turn-repository"
import { Effect, Stream } from "effect"

const executionStartedImplementation = (executionId: string, cursor?: string): ExecutionEvent.Event => ({
  executionId,
  cursor: cursor ?? `${executionId}:started`,
  sequence: 0,
  type: "execution.started",
  timestampSource: "baton",
  createdAt: 0,
})

export function executionStarted(executionId: string, cursor?: string): ExecutionEvent.Event
export function executionStarted(cursor?: string): (executionId: string) => ExecutionEvent.Event
export function executionStarted(
  executionIdOrCursor?: string,
  cursor?: string,
): ExecutionEvent.Event | ((executionId: string) => ExecutionEvent.Event) {
  if (executionIdOrCursor === undefined) return (executionId) => executionStartedImplementation(executionId, cursor)
  return executionStartedImplementation(executionIdOrCursor, cursor)
}

export const backend = ExecutionGateway.Service.of({
  startTurn: (input) =>
    Effect.succeed({ runId: `${input.turnId}-run`, turnId: input.turnId, threadId: input.threadId }),
  cancelTurn: () => Effect.void,
  steerTurn: () => Effect.void,
  watchTurn: (link) =>
    Stream.fromIterable([
      {
        executionId: link.runId,
        cursor: "cursor-started",
        sequence: 0,
        type: "execution.started",
        timestampSource: "baton",
        createdAt: 0,
      },
      {
        executionId: link.runId,
        cursor: "cursor-a",
        sequence: 1,
        type: "model.output.completed",
        createdAt: 1,
        text: "answer",
      },
      {
        executionId: link.runId,
        cursor: "cursor-b",
        sequence: 2,
        type: "execution.completed",
        timestampSource: "baton",
        createdAt: 2,
      },
    ]),
  inspectTurn: () => Effect.succeed({ status: "completed" }),
})

export const inspectTurnFromTurns = (turns: TurnContract.Interface) => (link: ExecutionGateway.ExecutionLink) =>
  turns.get(Turn.TurnId.make(link.turnId)).pipe(
    Effect.map((turn) => (turn === undefined ? { status: "unavailable" as const } : { status: turn.status })),
    Effect.orElseSucceed(() => ({ status: "unavailable" as const })),
  )
