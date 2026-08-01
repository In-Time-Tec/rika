import { Effect, Schema } from "effect"
import { AgentExecutionTurn, isAgentExecution } from "@rika/product/turn-record"
import { RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { turnRowJson } from "./turn-row-json-codec"
import { isTerminalStatus } from "./turn-memory-coordination"
import { missing, repositoryError } from "./turn-memory-errors"
import { clone } from "./turn-memory-state"
import type { MemoryState } from "./turn-memory-state"
import type { TurnMemoryContext } from "./turn-memory-state-operations"

export const makeTurnMemoryLifecycle = ({
  modifyState,
  readUnlocked,
  setUnlocked,
  withLock,
}: TurnMemoryContext): Pick<
  Interface,
  "setExtensionPin" | "setStatus" | "startAccepted" | "cancelAccepted" | "repairCursor"
> => ({
  setExtensionPin: Effect.fn("TurnRepository.setExtensionPin")(function* (id, pin) {
    const encoded = yield* Schema.encodeEffect(turnRowJson.extensionPin)(pin).pipe(Effect.mapError(repositoryError))
    return yield* withLock(
      Effect.gen(function* () {
        const currentState = yield* readUnlocked
        const current = currentState.turns.get(id)
        if (current === undefined || !isAgentExecution(current)) return yield* missing(id)
        if (
          current.extensionPin !== undefined &&
          (yield* Schema.encodeEffect(turnRowJson.extensionPin)(current.extensionPin).pipe(
            Effect.mapError(repositoryError),
          )) !== encoded
        )
          return yield* RepositoryError.make({ message: `Turn ${id} extension pin is immutable` })
        const next = { ...current, extensionPin: structuredClone(pin) }
        yield* setUnlocked({ ...currentState, turns: new Map(currentState.turns).set(id, next) })
        return clone(next)
      }),
    )
  }),
  setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, lastCursor, now) {
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
        if (!isAgentExecution(current)) return [{ _tag: "Missing" }, currentState]
        if (status === "queued" || current.status === "queued") return [{ _tag: "Queued" }, currentState]
        if (isTerminalStatus(current.status)) return [{ _tag: "Ok", turn: clone(current) }, currentState]
        const { lastCursor: previousCursor, ...withoutCursor } = current
        void previousCursor
        const next: AgentExecutionTurn = {
          ...withoutCursor,
          status,
          ...(lastCursor === undefined ? {} : { lastCursor }),
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
      if (current === undefined || !isAgentExecution(current) || current.status !== "accepted")
        return [false, currentState]
      const next: AgentExecutionTurn = { ...current, status: "running", updatedAt: now }
      return [true, { ...currentState, turns: new Map(currentState.turns).set(id, next) }]
    })
  }),
  cancelAccepted: Effect.fn("TurnRepository.cancelAccepted")(function* (id, now) {
    return yield* modifyState((currentState) => {
      const current = currentState.turns.get(id)
      if (current === undefined || !isAgentExecution(current) || current.status !== "accepted")
        return [false, currentState]
      const next: AgentExecutionTurn = { ...current, status: "cancelled", updatedAt: now }
      return [true, { ...currentState, turns: new Map(currentState.turns).set(id, next) }]
    })
  }),
  repairCursor: Effect.fn("TurnRepository.repairCursor")(function* (id, status, expectedCursor, cursor) {
    return yield* modifyState((currentState) => {
      const current = currentState.turns.get(id)
      if (
        current === undefined ||
        !isAgentExecution(current) ||
        current.status !== status ||
        current.lastCursor !== expectedCursor
      )
        return [false, currentState]
      const { lastCursor: previousCursor, ...withoutCursor } = current
      void previousCursor
      const next: AgentExecutionTurn = {
        ...withoutCursor,
        ...(cursor === undefined ? {} : { lastCursor: cursor }),
      }
      return [true, { ...currentState, turns: new Map(currentState.turns).set(id, next) }]
    })
  }),
})
