import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Operation } from "@rika/app"
import { Console, Effect, Logger, Semaphore } from "effect"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { serve } from "../../src/resident-transport"

const dataRoot = process.env.RIKA_TEST_RESIDENT_DATA_ROOT
const grace = process.env.RIKA_TEST_RESIDENT_GRACE ?? "500"
const finalizerDelay = Number(process.env.RIKA_TEST_RESIDENT_FINALIZER_DELAY ?? "0")
const delayedWork = process.env.RIKA_TEST_RESIDENT_DELAYED_WORK === "1"
if (dataRoot === undefined) throw new Error("data root required")

let activeWork = 0

const program = serve({
  profile: "default",
  dataRoot,
  graceMilliseconds: Number(grace),
  owner: (interactive) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => appendFile(join(dataRoot, "owner-acquisitions.log"), `${process.pid}\n`))
      const followOwnership = yield* Semaphore.make(1)
      let followCount = 0
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          appendFile(join(dataRoot, "owner-finalizer-starts.log"), `${process.pid}:${activeWork}\n`),
        ).pipe(
          Effect.andThen(Effect.sleep(finalizerDelay)),
          Effect.andThen(
            Effect.promise(() => appendFile(join(dataRoot, "owner-finalizations.log"), `${process.pid}\n`)),
          ),
        ),
      )
      return Operation.Service.of({
        run: (input) =>
          input._tag === "Interactive"
            ? input.prompt[0] === "reject-before-start"
              ? Effect.fail(
                  new Operation.OperationUnavailable({
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
                  submit: (prompt) =>
                    prompt === "ambiguous"
                      ? Effect.promise(() =>
                          appendFile(join(dataRoot, "mutation-attempts.log"), `${process.pid}\n`),
                        ).pipe(Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGKILL"))), Effect.asVoid)
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
                if (!delayedWork || input._tag !== "Run") return Console.log(JSON.stringify({ hostPid: process.pid }))
                return Effect.sync(() => {
                  activeWork += 1
                }).pipe(
                  Effect.andThen(
                    Effect.promise(() => appendFile(join(dataRoot, "delayed-work-starts.log"), `${process.pid}\n`)),
                  ),
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      activeWork -= 1
                    }).pipe(
                      Effect.andThen(
                        Effect.promise(() =>
                          appendFile(join(dataRoot, "delayed-work-finalizations.log"), `${process.pid}\n`),
                        ),
                      ),
                    ),
                  ),
                )
              }),
      })
    }),
})

BunRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.provide(BunServices.layer),
    Effect.provide(BunCrypto.layer),
    Effect.provide(Logger.layer([])),
  ),
)
