import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Clock, Effect } from "effect"

export interface Result {
  readonly active: ReadonlyArray<Turn.AgentExecutionTurn>
  readonly settledThreads: ReadonlyArray<Thread.ThreadId>
}

export interface Input {
  readonly turns: TurnRepository.Interface
  readonly backend: ExecutionGateway.Interface
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: ExecutionStatus.Status,
    now: number,
  ) => Effect.Effect<Turn.AgentExecutionTurn, Error, never>
}

export const make = Effect.fn("ExecutionAuthorityReconciliation.make")(function* (input: Input) {
  const active = new Array<Turn.AgentExecutionTurn>()
  const settledThreads = new Array<Thread.ThreadId>()
  const candidates = new Map<string, Turn.AgentExecutionTurn>()
  const replayRequired = new Set<string>()
  for (const turn of yield* input.turns.listNonterminal) {
    if (turn._tag === "AgentExecution" && turn.status !== "queued") candidates.set(String(turn.id), turn)
  }
  for (const steeringAdmission of yield* input.turns.listSteeringAdmissions) {
    if (steeringAdmission.outcome._tag !== "Accepted") continue
    const turn = yield* input.turns.get(Turn.TurnId.make(steeringAdmission.target.turnId))
    if (turn?._tag === "AgentExecution" && turn.status !== "queued") {
      candidates.set(String(turn.id), turn)
      replayRequired.add(String(turn.id))
    }
  }
  for (const turn of candidates.values()) {
    if (turn.executionLink === undefined) {
      yield* Effect.logWarning("execution.authority.link_missing").pipe(
        Effect.annotateLogs("rika.turn.id", String(turn.id)),
      )
      continue
    }
    const inspected = yield* Effect.result(input.backend.inspectTurn(turn.executionLink))
    if (inspected._tag === "Failure") {
      yield* Effect.logWarning("execution.authority.inspect_failed").pipe(
        Effect.annotateLogs({
          "rika.turn.id": String(turn.id),
          "rika.failure.kind": String(inspected.failure),
        }),
      )
      active.push(turn)
      continue
    }
    if (inspected.success.status === "unavailable") {
      yield* Effect.logWarning("execution.authority.run_unavailable").pipe(
        Effect.annotateLogs("rika.turn.id", String(turn.id)),
      )
      active.push(turn)
      continue
    }
    if (ExecutionStatus.isTerminalStatus(inspected.success.status)) {
      if (replayRequired.has(String(turn.id))) {
        active.push(turn)
        continue
      }
      yield* input.setTurnStatus(turn.id, inspected.success.status, yield* Clock.currentTimeMillis)
      settledThreads.push(turn.threadId)
      continue
    }
    active.push(turn)
  }
  return { active, settledThreads } satisfies Result
})
