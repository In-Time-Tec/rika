import { TurnResult } from "@rika/product/thread-result"
import { Effect } from "effect"
import { AgentExecutionTurn } from "@rika/product/turn-record"
import { RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { isTerminalStatus } from "./coordination"
import { missing } from "./errors"
import { clone } from "./state"
import type { MemoryState } from "./state"
import type { TurnMemoryContext } from "./state-operations"

export const makeTurnMemoryLifecycle = ({
  modifyState,
}: TurnMemoryContext): Pick<Interface, "setStatus" | "startAccepted" | "cancelUnlinked"> => ({
  setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, now) {
    const updated = yield* modifyState(
      (
        currentState,
      ): readonly [
        (
          | { readonly _tag: "Missing" }
          | { readonly _tag: "Queued" }
          | { readonly _tag: "Ok"; readonly turn: AgentExecutionTurn }
        ),
        MemoryState,
      ] => {
        const current = currentState.turns.get(id)
        if (current === undefined) return [{ _tag: "Missing" }, currentState]
        if (!TurnResult.isAgentExecution(current)) return [{ _tag: "Missing" }, currentState]
        if (status === "queued" || current.status === "queued") return [{ _tag: "Queued" }, currentState]
        if (isTerminalStatus(current.status)) return [{ _tag: "Ok", turn: clone(current) }, currentState]
        const next: AgentExecutionTurn = {
          ...current,
          status,
          updatedAt: now,
        }
        const withTurn: MemoryState = {
          ...currentState,
          turns: new Map(currentState.turns).set(id, next),
        }
        return [{ _tag: "Ok", turn: clone(next) }, withTurn]
      },
    )
    if (updated._tag === "Missing") return yield* missing(id)
    if (updated._tag === "Queued")
      return yield* RepositoryError.make({
        message: `Turn ${id} cannot transition into or out of 'queued' via setStatus`,
      })
    return updated.turn
  }),
  startAccepted: Effect.fn("TurnRepository.startAccepted")(function* (id, now) {
    return yield* modifyState((currentState) => {
      const current = currentState.turns.get(id)
      if (current === undefined || !TurnResult.isAgentExecution(current) || current.status !== "accepted")
        return [false, currentState]
      const next: AgentExecutionTurn = { ...current, status: "running", updatedAt: now }
      return [true, { ...currentState, turns: new Map(currentState.turns).set(id, next) }]
    })
  }),
  cancelUnlinked: Effect.fn("TurnRepository.cancelUnlinked")(function* (id, now) {
    return yield* modifyState((currentState) => {
      const current = currentState.turns.get(id)
      if (
        current === undefined ||
        !TurnResult.isAgentExecution(current) ||
        (current.status !== "accepted" && current.status !== "running") ||
        current.executionLink !== undefined
      )
        return [false, currentState]
      const next: AgentExecutionTurn = { ...current, status: "cancelled", updatedAt: now }
      return [true, { ...currentState, turns: new Map(currentState.turns).set(id, next) }]
    })
  }),
})
