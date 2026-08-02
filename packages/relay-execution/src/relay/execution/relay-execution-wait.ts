import { Client, Ids } from "@relayfx/sdk"
import { Effect } from "effect"

export const awaitExecutionAvailable = (input: {
  readonly client: Client.Interface
  readonly id: Ids.ExecutionId
}): Effect.Effect<void> => {
  const poll: Effect.Effect<void> = Effect.suspend(() =>
    input.client.executions.get(input.id).pipe(
      Effect.flatMap((existing) =>
        existing === undefined ? Effect.sleep("25 millis").pipe(Effect.andThen(poll)) : Effect.void,
      ),
      Effect.catchTag("ClientError", () => Effect.sleep("250 millis").pipe(Effect.andThen(poll))),
    ),
  )
  return poll
}

export const awaitExecutionRunning = (input: {
  readonly client: Client.Interface
  readonly id: Ids.ExecutionId
}): Effect.Effect<void, Client.ClientError> => {
  const poll: Effect.Effect<void, Client.ClientError> = Effect.suspend(() =>
    input.client.executions.get(input.id).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.sleep("250 millis").pipe(Effect.andThen(poll)),
        onSuccess: (existing) => {
          if (existing?.status === "running") return Effect.void
          if (existing === undefined || existing.status === "queued")
            return Effect.sleep("25 millis").pipe(Effect.andThen(poll))
          return Effect.fail(Client.ClientError.make({ message: `Execution is not running: ${input.id}` }))
        },
      }),
    ),
  )
  return poll
}
