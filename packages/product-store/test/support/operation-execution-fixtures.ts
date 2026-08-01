import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionInspection from "@rika/product/execution-inspection"
import * as TurnContract from "@rika/product/turn-repository"
import { Effect } from "effect"

const executionStartedImplementation = (executionId: string, cursor?: string): ExecutionEvent.Event => ({
  executionId,
  cursor: cursor ?? `${executionId}:started`,
  sequence: 0,
  type: "execution.started",
  timestampSource: "server",
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

export const backend = ExecutionBackend.Service.of({
  invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
  createFanOut: () => Effect.die("unused"),
  inspectFanOut: () => Effect.die("unused"),
  cancelFanOut: () => Effect.die("unused"),
  registerWorkflows: () => Effect.die("unused"),
  startWorkflow: () => Effect.die("unused"),
  inspectWorkflow: () => Effect.die("unused"),
  cancelWorkflow: () => Effect.die("unused"),
  start: (input) =>
    Effect.succeed({
      turnId: input.turnId,
      status: "completed" as const,
      events: [
        {
          executionId: String(input.turnId),
          cursor: "cursor-started",
          sequence: 0,
          type: "execution.started",
          timestampSource: "server",
          createdAt: 0,
        },
        {
          executionId: String(input.turnId),
          cursor: "cursor-a",
          sequence: 1,
          type: "model.output.completed",
          createdAt: 1,
          text: "answer",
        },
        {
          executionId: String(input.turnId),
          cursor: "cursor-b",
          sequence: 2,
          type: "execution.completed",
          timestampSource: "server",
          createdAt: 2,
        },
      ],
    }).pipe(Effect.tap((result) => Effect.sync(() => result.events.forEach((event) => input.onEvent?.(event))))),
  cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
  inspect: () => Effect.void.pipe(Effect.as(undefined)),
  replay: (turnId) =>
    Effect.succeed({
      turnId,
      status: "completed" as const,
      events: [
        {
          executionId: String(turnId),
          cursor: "cursor-started",
          sequence: 0,
          type: "execution.started" as const,
          timestampSource: "server" as const,
          createdAt: 0,
        },
        {
          executionId: String(turnId),
          cursor: "cursor-a",
          sequence: 1,
          type: "model.output.completed" as const,
          createdAt: 1,
          text: "answer",
        },
        {
          executionId: String(turnId),
          cursor: "cursor-b",
          sequence: 2,
          type: "execution.completed" as const,
          timestampSource: "server" as const,
          createdAt: 2,
        },
      ],
    }),
  steer: (turnId) => Effect.succeed({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
  resolveInvocationSource: () => Effect.die("unused"),
})

export const inspectFromTurns =
  (turns: TurnContract.Interface) =>
  (turnId: string): Effect.Effect<ExecutionInspection.Inspection | undefined, ExecutionBackend.BackendError> =>
    turns.get(Turn.TurnId.make(turnId)).pipe(
      Effect.map((turn) =>
        turn === undefined ? undefined : { turnId, status: turn.status, waits: [], pendingTools: [], children: [] },
      ),
      Effect.orElseSucceed(() => undefined),
    )

export function delegationEvent(
  cursor: string,
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): (executionId: string) => ExecutionEvent.Event
export function delegationEvent(
  executionId: string,
  cursor: string,
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): ExecutionEvent.Event
export function delegationEvent(
  executionIdOrCursor: string,
  cursorOrSequence: string | number,
  sequenceOrType: number | string,
  typeOrData: string | Record<string, unknown>,
  data?: Record<string, unknown>,
): ExecutionEvent.Event | ((executionId: string) => ExecutionEvent.Event) {
  if (typeof cursorOrSequence === "number") {
    if (
      typeof sequenceOrType !== "string" ||
      typeof typeOrData !== "object" ||
      typeOrData === null ||
      data !== undefined
    )
      throw new Error("Invalid delegation event arguments")
    return (executionId) =>
      delegationEvent(executionId, executionIdOrCursor, cursorOrSequence, sequenceOrType, typeOrData)
  }
  if (typeof sequenceOrType !== "number" || typeof typeOrData !== "string" || data === undefined)
    throw new Error("Invalid delegation event arguments")
  return {
    executionId: executionIdOrCursor,
    cursor: cursorOrSequence,
    sequence: sequenceOrType,
    type: typeOrData,
    timestampSource: "server",
    createdAt: sequenceOrType,
    data,
  }
}
