import { Clock, Effect } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import type { InteractiveEvent } from "./interactive-event"
import { operationFailureDetail } from "../operation-error"

export const makeInteractiveControl = (input: {
  readonly turns: TurnRepository.Interface
  readonly backend: ExecutionBackend.Interface
  readonly pendingCapacity: number
  readonly active: () => Effect.Effect<Turn.Turn, any, any>
  readonly dispatch: (event: InteractiveEvent) => void
  readonly queueMutation: (change: TurnRepository.QueueItemChange) => InteractiveEvent
  readonly nextSteeringIdentity: (turnId: string) => string
  readonly fail: (message: string) => Effect.Effect<never, any, never>
}) => {
  const editQueued = (id: string, prompt: string) =>
    Effect.gen(function* () {
      const turnId = Turn.TurnId.make(id)
      if ((yield* input.turns.get(turnId))?.status !== "queued")
        return yield* input.fail(`Turn ${turnId} is not queued`)
      const turn = yield* input.turns.editQueued(turnId, prompt, yield* Clock.currentTimeMillis)
      input.dispatch(input.queueMutation(turn.queue))
    })
  const dequeue = (id: string) =>
    Effect.gen(function* () {
      input.dispatch(input.queueMutation(yield* input.turns.dequeue(Turn.TurnId.make(id))))
    })
  const steer = (text: string, targetTurnId?: string) =>
    Effect.gen(function* () {
      const turn = yield* input.active()
      if (targetTurnId !== undefined && String(turn.id) !== targetTurnId)
        return yield* input.fail(`Steering target ${targetTurnId} is no longer the active turn`)
      const outcome = yield* Effect.exit(
        input.backend.steer(turn.id, text, input.nextSteeringIdentity(String(turn.id))),
      )
      if (outcome._tag === "Failure") {
        input.dispatch({
          _tag: "ExecutionControlFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "steer",
          message: operationFailureDetail(outcome.cause),
          steeringText: text,
        })
        return
      }
      input.dispatch({
        _tag: "ExecutionControlled",
        selectionEpoch: 0,
        threadId: turn.threadId,
        turnId: turn.id,
        action: "steered",
        steeringSequence: outcome.value.sequence,
        steeringText: text,
      })
    })
  const steerQueued = (id: string, text: string) =>
    Effect.gen(function* () {
      const turn = yield* input.active()
      const candidate = yield* input.turns.get(Turn.TurnId.make(id))
      if (candidate?.status === "queued" && candidate.promptParts?.some((part) => part.type === "image"))
        return yield* input.fail("Queued turns with images cannot be steered")
      const taken = yield* input.turns.takeQueued(Turn.TurnId.make(id))
      const queued = taken.turn
      const steeringText =
        queued.promptParts
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("") ??
        queued.prompt ??
        text
      input.dispatch(input.queueMutation(taken.queue))
      const outcome = yield* Effect.exit(input.backend.steer(turn.id, steeringText, `rika:queued-steer:${queued.id}`))
      if (outcome._tag === "Failure") {
        const restored = yield* input.turns.copy(queued, input.pendingCapacity)
        if (restored.queue === undefined) return yield* input.fail(`Turn ${queued.id} was not restored to its queue`)
        input.dispatch(input.queueMutation(restored.queue))
        input.dispatch({
          _tag: "ExecutionControlFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "steer",
          message: operationFailureDetail(outcome.cause),
          steeringText,
        })
        return
      }
      input.dispatch({
        _tag: "ExecutionControlled",
        selectionEpoch: 0,
        threadId: turn.threadId,
        turnId: turn.id,
        action: "steered",
        steeringSequence: outcome.value.sequence,
        steeringText,
      })
    })
  return { editQueued, dequeue, steerQueued, steer }
}
