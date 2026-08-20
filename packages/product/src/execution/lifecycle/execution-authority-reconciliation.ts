import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Clock, Effect, Semaphore } from "effect"

export const missingExecutionMessage = "The durable execution for this Turn is unavailable."

export interface Result {
  readonly active: ReadonlyArray<Turn.AgentExecutionTurn>
}

export interface Input {
  readonly turns: TurnRepository.Interface
  readonly transcripts: TranscriptRepository.Interface
  readonly backend: ExecutionGateway.Interface
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: ExecutionStatus.Status,
    now: number,
  ) => Effect.Effect<Turn.AgentExecutionTurn, Error, never>
}

const failureKey = (turnId: Turn.TurnId) => `turn:${turnId}:execution-unavailable`

const failureUnit = (
  turn: Turn.AgentExecutionTurn,
  revision: number,
  kind: "execution-link-missing" | "execution-run-missing",
): TranscriptUnit.Unit => {
  const key = failureKey(turn.id)
  const detail =
    kind === "execution-link-missing"
      ? "Rika no longer has the durable TenetKit Execution link for this Turn."
      : "TenetKit no longer has the durable Execution linked to this Turn."
  return {
    key,
    turnId: turn.id,
    order: TranscriptOrdering.unitOrder(key, Number.MAX_SAFE_INTEGER),
    revision,
    executionOutcome: { status: "failed", reason: missingExecutionMessage },
    content: {
      _tag: "Block",
      block: {
        _tag: "Error",
        title: "Execution unavailable",
        detail,
        turnId: turn.id,
        category: "execution-unavailable",
        retryable: false,
      },
    },
  }
}

export const make = Effect.fn("ExecutionAuthorityReconciliation.make")(function* (input: Input) {
  const admission = yield* Semaphore.make(1)
  const settleMissing = Effect.fn("ExecutionAuthorityReconciliation.settleMissing")(function* (
    turn: Turn.AgentExecutionTurn,
    kind: "execution-link-missing" | "execution-run-missing",
  ) {
    const now = yield* Clock.currentTimeMillis
    const projection = yield* input.transcripts.get(turn.id)
    if (projection?.units.some((unit) => unit.key === failureKey(turn.id)) !== true) {
      const revision = (projection?.units.reduce((maximum, unit) => Math.max(maximum, unit.revision), -1) ?? -1) + 1
      yield* input.transcripts.replaceUnits({ ...turn, status: "failed", updatedAt: now }, [
        ...(projection?.units ?? []),
        failureUnit(turn, revision, kind),
      ])
    }
    yield* input.setTurnStatus(turn.id, "failed", now)
    yield* Effect.logWarning("execution.authority.missing").pipe(
      Effect.annotateLogs({
        "rika.turn.id": String(turn.id),
        "rika.failure.kind": kind,
        "rika.failure.message": missingExecutionMessage,
      }),
    )
  })
  const reconcile = Effect.gen(function* () {
    const active = new Array<Turn.AgentExecutionTurn>()
    const candidates = new Map<string, Turn.AgentExecutionTurn>()
    for (const turn of yield* input.turns.listNonterminal) {
      if (turn._tag === "AgentExecution" && turn.status !== "queued") candidates.set(String(turn.id), turn)
    }
    for (const steeringAdmission of yield* input.turns.listSteeringAdmissions) {
      if (steeringAdmission.outcome._tag !== "Accepted") continue
      const turn = yield* input.turns.get(Turn.TurnId.make(steeringAdmission.target.turnId))
      if (turn?._tag === "AgentExecution") candidates.set(String(turn.id), turn)
    }
    for (const turn of candidates.values()) {
      // A Turn without an execution link (for example a forked copy of an active thread) has no
      // TenetKit authority to reconcile against; leave it untouched so fork semantics stay intact.
      if (turn.executionLink === undefined) continue
      const inspected = yield* Effect.result(input.backend.inspectTurn(turn.executionLink))
      if (inspected._tag === "Failure") {
        yield* Effect.logWarning("execution.authority.inspect_failed").pipe(
          Effect.annotateLogs({
            "rika.turn.id": String(turn.id),
            "rika.failure.kind": String(inspected.failure),
          }),
        )
        continue
      }
      if (inspected.success.status === "unavailable") {
        if (!ExecutionStatus.isTerminalStatus(turn.status)) yield* settleMissing(turn, "execution-run-missing")
        continue
      }
      active.push(turn)
    }
    return { active } satisfies Result
  }).pipe(Effect.withSpan("ExecutionAuthorityReconciliation.reconcile"))
  return yield* admission.withPermits(1)(reconcile)
})
