import * as ExecutionGateway from "@rika/product/execution-gateway"
import { RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { TurnResult } from "@rika/product/thread-result"
import { TurnId } from "@rika/product/turn-record"
import { Effect, Schema } from "effect"
import { clone } from "./state"
import { missing, repositoryError } from "./errors"
import type { MemoryState } from "./state"
import type { TurnMemoryContext } from "./state-operations"

const equivalentStartTurn = Schema.toEquivalence(ExecutionGateway.StartTurn)

type ExecutionLinkUpdate =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unprepared" }
  | { readonly _tag: "IdentityConflict" }
  | { readonly _tag: "LinkConflict" }
  | { readonly _tag: "Ok"; readonly turn: import("@rika/product/turn-record").AgentExecutionTurn }

export const makeTurnMemoryAdmission = ({
  modifyState,
  readState,
}: TurnMemoryContext): Pick<
  Interface,
  "prepareExecutionAdmission" | "listUnlinkedExecutionAdmissions" | "attachExecutionLink"
> => ({
  prepareExecutionAdmission: Effect.fn("TurnRepository.prepareExecutionAdmission")((input, now) =>
    Effect.gen(function* () {
      const prepared = yield* Schema.decodeUnknownEffect(ExecutionGateway.StartTurn)(input)
      const turnId = yield* Schema.decodeUnknownEffect(TurnId)(prepared.turnId)
      const result = yield* modifyState(
        (
          currentState,
        ): readonly [
          (
            | { readonly _tag: "Missing" }
            | { readonly _tag: "Conflict" }
            | { readonly _tag: "Ok"; readonly input: ExecutionGateway.StartTurn }
          ),
          MemoryState,
        ] => {
          const turn = currentState.turns.get(turnId)
          if (turn === undefined || !TurnResult.isAgentExecution(turn) || String(turn.threadId) !== prepared.threadId)
            return [{ _tag: "Missing" }, currentState]
          const existing = currentState.executionAdmissions.get(turnId)
          if (existing !== undefined)
            return equivalentStartTurn(existing.input, prepared)
              ? [{ _tag: "Ok", input: structuredClone(existing.input) }, currentState]
              : [{ _tag: "Conflict" }, currentState]
          const snapshot = structuredClone(prepared)
          return [
            { _tag: "Ok", input: structuredClone(snapshot) },
            {
              ...currentState,
              executionAdmissions: new Map(currentState.executionAdmissions).set(turnId, {
                input: snapshot,
                preparedAt: now,
              }),
            },
          ]
        },
      )
      if (result._tag === "Missing") return yield* missing(turnId)
      if (result._tag === "Conflict")
        return yield* RepositoryError.make({
          message: `Turn ${turnId} already has different prepared execution admission`,
        })
      return result.input
    }).pipe(Effect.mapError(repositoryError)),
  ),
  listUnlinkedExecutionAdmissions: readState.pipe(
    Effect.map((state) =>
      [...state.executionAdmissions.entries()]
        .filter(([turnId]) => {
          const turn = state.turns.get(turnId)
          return turn !== undefined && TurnResult.isAgentExecution(turn) && turn.executionLink === undefined
        })
        .toSorted(
          ([leftId, left], [rightId, right]) => left.preparedAt - right.preparedAt || leftId.localeCompare(rightId),
        )
        .map(([, admission]) => structuredClone(admission.input)),
    ),
    Effect.withSpan("TurnRepository.listUnlinkedExecutionAdmissions"),
  ),
  attachExecutionLink: Effect.fn("TurnRepository.attachExecutionLink")(function* (id, link, now) {
    const updated = yield* modifyState((currentState): readonly [ExecutionLinkUpdate, MemoryState] => {
      const current = currentState.turns.get(id)
      if (current === undefined || !TurnResult.isAgentExecution(current))
        return [{ _tag: "Missing" as const }, currentState] as const
      if (current.executionLink !== undefined) {
        const matches =
          current.executionLink.runId === link.runId &&
          current.executionLink.turnId === link.turnId &&
          current.executionLink.threadId === link.threadId
        if (!matches) return [{ _tag: "LinkConflict" as const }, currentState] as const
        const executionAdmissions = new Map(currentState.executionAdmissions)
        executionAdmissions.delete(id)
        return [
          { _tag: "Ok" as const, turn: clone(current) },
          { ...currentState, executionAdmissions },
        ] as const
      }
      const admission = currentState.executionAdmissions.get(id)
      if (admission === undefined) return [{ _tag: "Unprepared" as const }, currentState] as const
      if (link.turnId !== admission.input.turnId || link.threadId !== admission.input.threadId)
        return [{ _tag: "IdentityConflict" as const }, currentState] as const
      const next = { ...current, executionLink: structuredClone(link), updatedAt: now }
      const executionAdmissions = new Map(currentState.executionAdmissions)
      executionAdmissions.delete(id)
      return [
        { _tag: "Ok" as const, turn: clone(next) },
        { ...currentState, turns: new Map(currentState.turns).set(id, next), executionAdmissions },
      ] as const
    })
    if (updated._tag === "Missing") return yield* missing(id)
    if (updated._tag === "Unprepared")
      return yield* RepositoryError.make({ message: `Turn ${id} has no prepared execution admission` })
    if (updated._tag === "IdentityConflict")
      return yield* RepositoryError.make({
        message: `Execution link does not identify prepared admission for Turn ${id}`,
      })
    if (updated._tag === "LinkConflict")
      return yield* RepositoryError.make({ message: `Turn ${id} already has a different execution link` })
    return updated.turn
  }),
})
