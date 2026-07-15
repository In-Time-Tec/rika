import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Operation } from "@rika/app"
import { Config, Console, Effect, FileSystem, Layer, Logger, Path, Schema, Semaphore } from "effect"
import { serve } from "../../src/resident-transport"

let activeWork = 0

const program = Effect.gen(function* () {
  const dataRoot = yield* Config.string("RIKA_TEST_RESIDENT_DATA_ROOT")
  const grace = yield* Config.string("RIKA_TEST_RESIDENT_GRACE").pipe(Config.withDefault("500"))
  const finalizerDelay = Number(
    yield* Config.string("RIKA_TEST_RESIDENT_FINALIZER_DELAY").pipe(Config.withDefault("0")),
  )
  const delayedWork = (yield* Config.string("RIKA_TEST_RESIDENT_DELAYED_WORK").pipe(Config.withDefault("0"))) === "1"
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const append = (name: string, value: string) =>
    fs.writeFileString(path.join(dataRoot, name), value, { flag: "a" }).pipe(Effect.orDie)
  return yield* serve({
    profile: "default",
    dataRoot,
    graceMilliseconds: Number(grace),
    owner: (interactive) =>
      Effect.gen(function* () {
        yield* append("owner-acquisitions.log", `${process.pid}\n`)
        const followOwnership = yield* Semaphore.make(1)
        let followCount = 0
        yield* Effect.addFinalizer(() =>
          append("owner-finalizer-starts.log", `${process.pid}:${activeWork}\n`).pipe(
            Effect.andThen(Effect.sleep(finalizerDelay)),
            Effect.andThen(append("owner-finalizations.log", `${process.pid}\n`)),
          ),
        )
        return Operation.Service.of({
          run: (input) =>
            input._tag === "Interactive"
              ? input.prompt[0] === "reject-before-start"
                ? Effect.fail(
                    Operation.OperationUnavailable.make({
                      operation: "Interactive",
                      message: "Interactive setup rejected",
                    }),
                  )
                : interactive(input, {
                    initialize: (dispatch) =>
                      Effect.sync(() => {
                        const count = input.prompt[0] === "burst-events" ? 2_000 : 1
                        for (let index = 0; index < count; index += 1) dispatch({ _tag: "ThreadsListed", threads: [] })
                      }),
                    watchThreads: () => Effect.never,
                    submit: (prompt) =>
                      prompt === "ambiguous"
                        ? append("mutation-attempts.log", `${process.pid}\n`).pipe(
                            Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGKILL"))),
                            Effect.asVoid,
                          )
                        : Effect.void,
                    shell: () => Effect.void,
                    editQueued: () => Effect.void,
                    dequeue: () => Effect.void,
                    steerQueued: () => Effect.void,
                    steer: () => Effect.void,
                    interruptAndSend: () => Effect.void,
                    cancel: () => Effect.void,
                    resolvePermission: () => Effect.void,
                    selectThread: () => Effect.void,
                    previewThread: () => Effect.void,
                    reopenThread: () => Effect.void,
                    followSelected: (dispatch) =>
                      followOwnership.withPermits(1)(
                        Effect.sync(() => {
                          followCount += 1
                          return followCount
                        }).pipe(
                          Effect.flatMap((count) =>
                            count === 1
                              ? Effect.never
                              : Effect.sync(() => dispatch({ _tag: "ThreadsListed", threads: [] })),
                          ),
                        ),
                      ),
                    replay: () => Effect.void,
                  })
              : Effect.suspend(() => {
                  if (!delayedWork || input._tag !== "Run")
                    return Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({ hostPid: process.pid }).pipe(
                      Effect.flatMap(Console.log),
                      Effect.orDie,
                    )
                  return Effect.sync(() => {
                    activeWork += 1
                  }).pipe(
                    Effect.andThen(append("delayed-work-starts.log", `${process.pid}\n`)),
                    Effect.andThen(Effect.never),
                    Effect.ensuring(
                      Effect.sync(() => {
                        activeWork -= 1
                      }).pipe(Effect.andThen(append("delayed-work-finalizations.log", `${process.pid}\n`))),
                    ),
                  )
                }),
        })
      }),
  })
})

BunRuntime.runMain(
  Layer.launch(
    Layer.effectDiscard(Effect.scoped(program)).pipe(
      Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, Logger.layer([]))),
    ),
  ),
)
