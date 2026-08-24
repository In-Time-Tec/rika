import { Effect, Schema } from "effect"
import * as ExecutionStatus from "@rika/product/execution-status"
import {
  ExecutionLink,
  PendingSteeringMaxEntries,
  SteeringFailure,
  SteeringInput,
  SteeringReceipt,
} from "@rika/product/execution-gateway"
import { RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { SteeringAdmission } from "@rika/product/turn-repository-steering"
import { AgentExecutionTurn, TurnId } from "@rika/product/turn-record"
import { queueState, withQueueState } from "./queue-state"
import { clone } from "./state"
import type { MemoryState } from "./state"
import type { TurnMemoryContext } from "./state-operations"
import { queuedTurnUnavailable } from "./errors"

const equivalentTarget = Schema.toEquivalence(ExecutionLink)
const equivalentInput = Schema.toEquivalence(SteeringInput)
const equivalentReceipt = Schema.toEquivalence(SteeringReceipt)
const equivalentFailure = Schema.toEquivalence(SteeringFailure)
type Preparation = Effect.Success<ReturnType<Interface["prepareQueuedSteeringAdmission"]>>
type PrepareResult<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "RepositoryError"; readonly message: string }
  | { readonly _tag: "Unavailable" }

const cloneOutcome = (outcome: SteeringAdmission["outcome"]): SteeringAdmission["outcome"] => {
  if (outcome._tag === "Pending") return { _tag: "Pending" }
  if (outcome._tag === "Accepted") return { _tag: "Accepted", receipt: structuredClone(outcome.receipt) }
  return {
    _tag: "Rejected",
    failure: SteeringFailure.make({ kind: outcome.failure.kind, message: outcome.failure.message }),
    ...(outcome.queue === undefined ? {} : { queue: structuredClone(outcome.queue) }),
  }
}

const cloneAdmission = (admission: SteeringAdmission): SteeringAdmission => ({
  target: structuredClone(admission.target),
  input: structuredClone(admission.input),
  ...(admission.source === undefined ? {} : { source: clone(admission.source) }),
  ...(admission.sourceWithdrawn === undefined ? {} : { sourceWithdrawn: admission.sourceWithdrawn }),
  preparedAt: admission.preparedAt,
  outcome: cloneOutcome(admission.outcome),
})

const sameSource = (left: SteeringAdmission["source"], right: AgentExecutionTurn | undefined) =>
  left === undefined ? right === undefined : right !== undefined && left.id === right.id

const sameRequest = (
  admission: SteeringAdmission,
  target: ExecutionLink,
  input: SteeringInput,
  source: AgentExecutionTurn | undefined,
) =>
  equivalentTarget(admission.target, target) &&
  equivalentInput(admission.input, input) &&
  sameSource(admission.source, source)

const activeTarget = (state: MemoryState, target: ExecutionLink): AgentExecutionTurn | undefined => {
  const turn = state.turns.get(TurnId.make(target.turnId))
  return turn?._tag === "AgentExecution" &&
    ExecutionStatus.isActiveStatus(turn.status) &&
    turn.executionLink !== undefined &&
    equivalentTarget(turn.executionLink, target)
    ? turn
    : undefined
}

const steeringCount = (state: MemoryState, target: ExecutionLink, pendingRequestIds: ReadonlyArray<string>): number => {
  const requests = new Set(pendingRequestIds)
  for (const admission of state.steeringAdmissions.values())
    if (
      admission.target.turnId === target.turnId &&
      admission.target.runId === target.runId &&
      admission.outcome._tag !== "Rejected"
    )
      requests.add(admission.input.idempotencyKey)
  return requests.size
}

const pendingAdmission = (
  target: ExecutionLink,
  input: SteeringInput,
  source: AgentExecutionTurn | undefined,
  now: number,
  sourceWithdrawn = false,
): SteeringAdmission => ({
  target: structuredClone(target),
  input: structuredClone(input),
  ...(source === undefined ? {} : { source: clone(source) }),
  ...(sourceWithdrawn ? { sourceWithdrawn: true } : {}),
  preparedAt: now,
  outcome: { _tag: "Pending" },
})

export const makeTurnMemorySteeringAdmission = ({
  modifyState,
  readState,
}: TurnMemoryContext): Pick<
  Interface,
  | "prepareSteeringAdmission"
  | "prepareQueuedSteeringAdmission"
  | "listSteeringAdmissions"
  | "acceptSteeringAdmission"
  | "rejectSteeringAdmission"
  | "completeSteeringAdmission"
  | "completeRejectedSteeringAdmission"
> => {
  const prepareDirect = (
    target: ExecutionLink,
    input: SteeringInput,
    pendingRequestIds: ReadonlyArray<string>,
    now: number,
  ) =>
    modifyState((state): readonly [PrepareResult<SteeringAdmission>, MemoryState] => {
      const existing = state.steeringAdmissions.get(input.idempotencyKey)
      if (existing !== undefined)
        return [
          sameRequest(existing, target, input, undefined)
            ? { _tag: "Ok", value: cloneAdmission(existing) }
            : { _tag: "RepositoryError", message: `Steering request ${input.idempotencyKey} conflicts` },
          state,
        ]
      if (activeTarget(state, target) === undefined)
        return [{ _tag: "RepositoryError", message: `Steering target ${target.turnId} is not active` }, state]
      const count = steeringCount(state, target, pendingRequestIds)
      if (count >= PendingSteeringMaxEntries)
        return [
          {
            _tag: "RepositoryError",
            message: `Turn ${target.turnId} already has the maximum number of pending steering requests`,
          },
          state,
        ]
      const admission = pendingAdmission(target, input, undefined, now)
      return [
        { _tag: "Ok", value: cloneAdmission(admission) },
        { ...state, steeringAdmissions: new Map(state.steeringAdmissions).set(input.idempotencyKey, admission) },
      ]
    })

  return {
    prepareSteeringAdmission: Effect.fn("TurnRepository.prepareSteeringAdmission")(
      function* (target, input, pendingRequestIds, now) {
        const result = yield* prepareDirect(target, input, pendingRequestIds, now)
        if (result._tag === "RepositoryError") return yield* RepositoryError.make({ message: result.message })
        if (result._tag === "Unavailable")
          return yield* RepositoryError.make({ message: "Steering admission unavailable" })
        return result.value
      },
    ),
    prepareQueuedSteeringAdmission: Effect.fn("TurnRepository.prepareQueuedSteeringAdmission")(
      function* (source, target, input, pendingRequestIds, now) {
        const result: PrepareResult<Preparation> = yield* modifyState(
          (state): readonly [PrepareResult<Preparation>, MemoryState] => {
            const byRequest = state.steeringAdmissions.get(input.idempotencyKey)
            const bySource = [...state.steeringAdmissions.values()].find((admission) => admission.source?.id === source)
            const existing = byRequest ?? bySource
            if (existing !== undefined) {
              if (byRequest !== bySource || !sameRequest(existing, target, input, existing.source))
                return [
                  {
                    _tag: "RepositoryError",
                    message: `Queued turn ${source} already has a different steering admission`,
                  },
                  state,
                ]
              const queue = queueState(state, existing.source!.threadId)
              const queueChange =
                existing.outcome._tag === "Rejected" && existing.outcome.queue !== undefined
                  ? structuredClone(existing.outcome.queue)
                  : {
                      threadId: existing.source!.threadId,
                      revision: queue.revision,
                      queuedCount: queue.queuedCount,
                      becameNonempty: false,
                      change: { _tag: "Removed" as const, turnId: existing.source!.id },
                    }
              return [
                {
                  _tag: "Ok",
                  value: {
                    admission: cloneAdmission(existing),
                    queue: queueChange,
                    queueChanged: false,
                  },
                },
                state,
              ]
            }
            const sourceTurn = state.turns.get(source)
            if (sourceTurn?._tag !== "AgentExecution" || sourceTurn.status !== "queued")
              return [{ _tag: "Unavailable" }, state]
            const targetTurn = activeTarget(state, target)
            if (targetTurn === undefined)
              return [{ _tag: "RepositoryError", message: `Steering target ${target.turnId} is not active` }, state]
            if (sourceTurn.threadId !== targetTurn.threadId)
              return [
                {
                  _tag: "RepositoryError",
                  message: `Queued turn ${source} does not belong to target ${target.turnId}`,
                },
                state,
              ]
            const count = steeringCount(state, target, pendingRequestIds)
            if (count >= PendingSteeringMaxEntries)
              return [
                {
                  _tag: "RepositoryError",
                  message: `Turn ${target.turnId} already has the maximum number of pending steering requests`,
                },
                state,
              ]
            const admission = pendingAdmission(target, input, sourceTurn, now, true)
            const previous = queueState(state, sourceTurn.threadId)
            const next = {
              revision: previous.revision + 1,
              queuedCount: Math.max(0, previous.queuedCount - 1),
            }
            const claims = new Map(state.claims)
            claims.delete(source)
            const admissions = new Map(state.steeringAdmissions).set(input.idempotencyKey, admission)
            return [
              {
                _tag: "Ok",
                value: {
                  admission: cloneAdmission(admission),
                  queue: {
                    threadId: sourceTurn.threadId,
                    revision: next.revision,
                    queuedCount: next.queuedCount,
                    becameNonempty: false,
                    change: { _tag: "Removed", turnId: sourceTurn.id },
                  },
                  queueChanged: true,
                },
              },
              withQueueState({ ...state, claims, steeringAdmissions: admissions }, sourceTurn.threadId, next),
            ]
          },
        )
        if (result._tag === "Unavailable") return yield* queuedTurnUnavailable(source)
        if (result._tag === "RepositoryError") return yield* RepositoryError.make({ message: result.message })
        return result.value
      },
    ),
    listSteeringAdmissions: readState.pipe(
      Effect.map((state) =>
        [...state.steeringAdmissions.values()]
          .toSorted(
            (left, right) =>
              left.preparedAt - right.preparedAt || left.input.idempotencyKey.localeCompare(right.input.idempotencyKey),
          )
          .map(cloneAdmission),
      ),
    ),
    acceptSteeringAdmission: Effect.fn("TurnRepository.acceptSteeringAdmission")(function* (requestId, receipt) {
      const result = yield* modifyState((state): readonly [PrepareResult<SteeringAdmission>, MemoryState] => {
        const admission = state.steeringAdmissions.get(requestId)
        if (admission === undefined)
          return [{ _tag: "RepositoryError", message: `Steering admission ${requestId} does not exist` }, state]
        if (admission.outcome._tag === "Rejected")
          return [{ _tag: "RepositoryError", message: `Steering admission ${requestId} was rejected` }, state]
        if (admission.outcome._tag === "Accepted")
          return [
            equivalentReceipt(admission.outcome.receipt, receipt)
              ? { _tag: "Ok", value: cloneAdmission(admission) }
              : { _tag: "RepositoryError", message: `Steering admission ${requestId} receipt conflicts` },
            state,
          ]
        const accepted: SteeringAdmission = {
          ...admission,
          outcome: { _tag: "Accepted", receipt: structuredClone(receipt) },
        }
        return [
          { _tag: "Ok", value: cloneAdmission(accepted) },
          { ...state, steeringAdmissions: new Map(state.steeringAdmissions).set(requestId, accepted) },
        ]
      })
      if (result._tag === "RepositoryError") return yield* RepositoryError.make({ message: result.message })
      if (result._tag === "Unavailable")
        return yield* RepositoryError.make({ message: `Steering admission ${requestId} is unavailable` })
      return result.value
    }),
    rejectSteeringAdmission: Effect.fn("TurnRepository.rejectSteeringAdmission")(function* (requestId, failure) {
      const result = yield* modifyState((state): readonly [PrepareResult<SteeringAdmission>, MemoryState] => {
        const admission = state.steeringAdmissions.get(requestId)
        if (admission === undefined)
          return [{ _tag: "RepositoryError", message: `Steering admission ${requestId} does not exist` }, state]
        if (admission.outcome._tag === "Accepted")
          return [{ _tag: "RepositoryError", message: `Steering admission ${requestId} was accepted` }, state]
        if (admission.outcome._tag === "Rejected")
          return [
            equivalentFailure(admission.outcome.failure, failure)
              ? { _tag: "Ok", value: cloneAdmission(admission) }
              : { _tag: "RepositoryError", message: `Steering admission ${requestId} rejection conflicts` },
            state,
          ]
        let nextState = state
        let queue: Preparation["queue"] | undefined
        if (admission.source !== undefined) {
          const existing = state.turns.get(admission.source.id)
          if (existing !== undefined && existing.status === "queued") {
            const position = [...state.turns.values()]
              .filter(
                (candidate): candidate is AgentExecutionTurn =>
                  candidate._tag === "AgentExecution" &&
                  candidate.threadId === admission.source!.threadId &&
                  candidate.status === "queued" &&
                  (candidate.id === admission.source!.id ||
                    ![...state.steeringAdmissions.values()].some(
                      (other) =>
                        other.input.idempotencyKey !== requestId &&
                        other.source?.id === candidate.id &&
                        other.outcome._tag !== "Rejected",
                    )),
              )
              .toSorted((left, right) => left.createdAt - right.createdAt)
              .findIndex((candidate) => candidate.id === admission.source!.id)
            const previous = queueState(state, admission.source.threadId)
            const next = {
              revision: previous.revision + 1,
              queuedCount: previous.queuedCount + (admission.sourceWithdrawn === true ? 1 : 0),
            }
            const turn: AgentExecutionTurn = existing
            queue = {
              threadId: turn.threadId,
              revision: next.revision,
              queuedCount: next.queuedCount,
              becameNonempty: admission.sourceWithdrawn === true && next.queuedCount === 1,
              change:
                admission.sourceWithdrawn === true
                  ? { _tag: "Added", turn: clone(turn), position }
                  : { _tag: "Updated", turn: clone(turn) },
            }
            nextState = withQueueState(state, turn.threadId, next)
          }
        }
        const rejected: SteeringAdmission = {
          ...admission,
          outcome: {
            _tag: "Rejected",
            failure: SteeringFailure.make({ kind: failure.kind, message: failure.message }),
            ...(queue === undefined ? {} : { queue }),
          },
        }
        return [
          { _tag: "Ok", value: cloneAdmission(rejected) },
          {
            ...nextState,
            steeringAdmissions: new Map(nextState.steeringAdmissions).set(requestId, rejected),
          },
        ]
      })
      if (result._tag === "RepositoryError") return yield* RepositoryError.make({ message: result.message })
      if (result._tag === "Unavailable")
        return yield* RepositoryError.make({ message: `Steering admission ${requestId} is unavailable` })
      return result.value
    }),
    completeSteeringAdmission: Effect.fn("TurnRepository.completeSteeringAdmission")(
      function* (requestId, target, receipt) {
        const result = yield* modifyState(
          (state): readonly [PrepareResult<Preparation["queue"] | undefined>, MemoryState] => {
            const steeringAdmission = state.steeringAdmissions.get(requestId)
            if (steeringAdmission === undefined) return [{ _tag: "Ok", value: undefined }, state]
            if (
              steeringAdmission.outcome._tag !== "Accepted" ||
              !equivalentTarget(steeringAdmission.target, target) ||
              !equivalentReceipt(steeringAdmission.outcome.receipt, receipt)
            )
              return [
                { _tag: "RepositoryError", message: `Steering admission ${requestId} disposition conflicts` },
                state,
              ]
            const admissions = new Map(state.steeringAdmissions)
            admissions.delete(requestId)
            let nextState: MemoryState = { ...state, steeringAdmissions: admissions }
            let queue: Preparation["queue"] | undefined
            const source = steeringAdmission.source
            if (source !== undefined) {
              const existing = nextState.turns.get(source.id)
              if (existing !== undefined && existing.status === "queued") {
                const turns = new Map(nextState.turns)
                turns.delete(source.id)
                const claims = new Map(nextState.claims)
                claims.delete(source.id)
                if (steeringAdmission.sourceWithdrawn === true)
                  return [
                    { _tag: "Ok", value: undefined },
                    { ...nextState, turns, claims },
                  ]
                const previous = queueState(nextState, source.threadId)
                const next = {
                  revision: previous.revision + 1,
                  queuedCount: Math.max(0, previous.queuedCount - 1),
                }
                queue = {
                  threadId: source.threadId,
                  revision: next.revision,
                  queuedCount: next.queuedCount,
                  becameNonempty: false,
                  change: { _tag: "Removed", turnId: source.id },
                }
                nextState = withQueueState({ ...nextState, turns, claims }, source.threadId, next)
              }
            }
            return [{ _tag: "Ok", value: queue }, nextState]
          },
        )
        if (result._tag === "RepositoryError") return yield* RepositoryError.make({ message: result.message })
        if (result._tag === "Unavailable")
          return yield* RepositoryError.make({ message: `Steering admission ${requestId} is unavailable` })
        return result.value
      },
    ),
    completeRejectedSteeringAdmission: Effect.fn("TurnRepository.completeRejectedSteeringAdmission")(
      function* (requestId) {
        const result = yield* modifyState((state): readonly [PrepareResult<boolean>, MemoryState] => {
          const steeringAdmission = state.steeringAdmissions.get(requestId)
          if (steeringAdmission === undefined) return [{ _tag: "Ok", value: true }, state]
          if (steeringAdmission.outcome._tag !== "Rejected")
            return [{ _tag: "RepositoryError", message: `Steering admission ${requestId} was not rejected` }, state]
          const admissions = new Map(state.steeringAdmissions)
          admissions.delete(requestId)
          return [
            { _tag: "Ok", value: true },
            { ...state, steeringAdmissions: admissions },
          ]
        })
        if (result._tag === "RepositoryError") return yield* RepositoryError.make({ message: result.message })
        if (result._tag === "Unavailable")
          return yield* RepositoryError.make({ message: `Steering admission ${requestId} is unavailable` })
        return result.value
      },
    ),
  }
}
