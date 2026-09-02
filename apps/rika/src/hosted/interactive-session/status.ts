import type * as InteractiveConnection from "@rika/product/interactive-connection"
import { Effect, Option, SubscriptionRef } from "effect"
import type { Projection } from "./projection"

export const interactiveSessionStatus = Effect.gen(function* () {
  const initialState: InteractiveConnection.State = { connectivity: "connecting", target: "resolving", participants: 0 }
  const state = yield* SubscriptionRef.make(initialState)
  const update = (change: (previousState: InteractiveConnection.State) => InteractiveConnection.State) =>
    SubscriptionRef.updateSome(state, (previousState) => {
      const next = change(previousState)
      return next === previousState ? Option.none() : Option.some(next)
    })
  const setActivity = (activity: InteractiveConnection.Activity) =>
    update((previousState) => (previousState.activity === activity ? previousState : { ...previousState, activity }))
  const setParticipants = (participants: number) =>
    update((previousState) =>
      previousState.participants === participants ? previousState : { ...previousState, participants },
    )
  const settlePromptActivity = update((previousState) =>
    previousState.activity === "sandbox-preparing" ||
    previousState.activity === "sandbox-waking" ||
    previousState.activity === "prompt-waiting"
      ? { ...previousState, activity: "executor-waiting" }
      : previousState,
  )
  const publishProjection = (projection: Projection) =>
    update((previousState) =>
      previousState.target === projection.target &&
      previousState.activity === projection.activity &&
      previousState.participants === projection.participants
        ? previousState
        : {
            ...previousState,
            target: projection.target,
            activity: projection.activity,
            participants: projection.participants,
          },
    )
  return { initialState, state, update, setActivity, setParticipants, settlePromptActivity, publishProjection }
})
