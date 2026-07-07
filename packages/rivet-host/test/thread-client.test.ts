import { describe, expect, test } from "bun:test"
import { Action as RivetAction, Actor as RivetActor, Client as RivetClient, RivetError } from "@rivetkit/effect"
import { Ids } from "@rika/schema"
import { Effect, Exit, Layer, Option } from "effect"
import * as RivetkitErrors from "rivetkit/errors"
import { ThreadActor, ThreadClient } from "../src/index"

const threadId = Ids.ThreadId.make("thread_client_test")

describe("ThreadClient", () => {
  test("preserves non-retryable Rivet errors in the client error channel", async () => {
    const error = RivetError.fromUnknown(new RivetkitErrors.RivetError("actor", "not_found", "actor not found"))
    const exit = await Effect.runPromise(
      ThreadClient.getSnapshot({ thread_id: threadId }).pipe(
        Effect.exit,
        Effect.provide(ThreadClient.layer.pipe(Layer.provide(fakeClientLayer(() => Effect.fail(error))))),
      ),
    )

    expect(errorFromExit(exit)).toBe(error)
  })

  test("retries retryable Rivet errors before returning the snapshot", async () => {
    const retryable = RivetError.fromUnknown(new RivetkitErrors.RivetError("actor", "restarting", "restarting"))
    let attempts = 0
    const exit = await Effect.runPromise(
      ThreadClient.getSnapshot({ thread_id: threadId }).pipe(
        Effect.exit,
        Effect.provide(
          ThreadClient.layer.pipe(
            Layer.provide(
              fakeClientLayer(() => {
                attempts += 1
                return attempts === 1 ? Effect.fail(retryable) : Effect.succeed(snapshot())
              }),
            ),
          ),
        ),
      ),
    )

    expect(exit._tag).toBe("Success")
    expect(attempts).toBe(2)
  })
})

const fakeClientLayer = (
  getSnapshot: (
    payload: ThreadActor.ThreadIdPayload,
  ) => Effect.Effect<ThreadActor.ThreadActorSnapshot, ThreadClient.RunError>,
) =>
  Layer.succeed(
    RivetClient.Client,
    RivetClient.Client.of({
      "~@rivetkit/effect/Client": "~@rivetkit/effect/Client",
      makeActorAccessor: <Actions extends RivetAction.AnyWithProps>() =>
        fakeAccessor<Actions>((payload: ThreadActor.ThreadIdPayload) => Effect.suspend(() => getSnapshot(payload))),
    }),
  )

const fakeAccessor = <Actions extends RivetAction.AnyWithProps>(
  getSnapshot: (
    payload: ThreadActor.ThreadIdPayload,
  ) => Effect.Effect<ThreadActor.ThreadActorSnapshot, ThreadClient.RunError>,
): RivetActor.Accessor<Actions> => ({
  getOrCreate: () => {
    const handle: RivetActor.Handle<Actions> = new Proxy(Object.create(null), {
      get: (_target, property) => {
        if (property === "GetSnapshot") return getSnapshot
        return () => Effect.succeed(snapshot())
      },
    })
    return handle
  },
})

const errorFromExit = <A, E>(exit: Exit.Exit<A, E>) => Option.getOrUndefined(Exit.findErrorOption(exit))

const snapshot = (): ThreadActor.ThreadActorSnapshot => ({
  thread_id: threadId,
  last_sequence: 1,
  message_count: 0,
  archived: false,
  active_turn_status: "idle",
})
