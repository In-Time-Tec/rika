import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Fiber, Logger, Stream } from "effect"
import { ResidentService } from "@rika/app"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { join } from "node:path"
import { make } from "../../src/resident-transport"

const dataRoot = process.env.RIKA_TEST_RESIDENT_DATA_ROOT
const grace = process.env.RIKA_TEST_RESIDENT_GRACE ?? "500"
if (dataRoot === undefined) throw new Error("data root required")

const readLines = async function* () {
  for await (const chunk of process.stdin) {
    for (const line of String(chunk).split("\n")) if (line.length > 0) yield line
  }
}

const program = Effect.gen(function* () {
  const service = yield* make()
  const connected = yield* Effect.result(
    service.getOrCreate({
      profile: "default",
      dataRoot,
      clientKind: "run",
      clientVersion: "test",
      graceMilliseconds: Number(grace),
      startHost: () =>
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const handle = yield* spawner.spawn(
            ChildProcess.make(process.execPath, ["test/fixtures/resident-host.ts"], {
              cwd: import.meta.dir.replace(/\/test\/fixtures$/, ""),
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              extendEnv: true,
              env: {
                RIKA_TEST_RESIDENT_DATA_ROOT: dataRoot,
                RIKA_TEST_RESIDENT_GRACE: grace,
                RIKA_TEST_RESIDENT_FINALIZER_DELAY: process.env.RIKA_TEST_RESIDENT_FINALIZER_DELAY ?? "0",
                RIKA_TEST_RESIDENT_DELAYED_WORK: process.env.RIKA_TEST_RESIDENT_DELAYED_WORK ?? "0",
              },
            }),
          )
          yield* handle.unref
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ResidentService.ResidentServiceError({
                reason: "transport-failed",
                message: String(cause),
              }),
          ),
        ),
    }),
  )
  if (connected._tag === "Failure") {
    yield* Effect.sync(() => console.log(JSON.stringify({ type: "rejected", error: connected.failure.message })))
    return
  }
  const connection = connected.success
  let hostPid = 0
  yield* connection.run(
    { _tag: "Doctor" },
    {
      stdout: (text) =>
        Effect.sync(() => {
          const parsed = JSON.parse(text) as { hostPid: number }
          hostPid = parsed.hostPid
        }),
    },
  )
  yield* Effect.sync(() =>
    console.log(
      JSON.stringify({
        type: "attached",
        role: connection.role,
        id: connection.connectionId,
        clientPid: process.pid,
        hostPid,
      }),
    ),
  )
  yield* Stream.fromAsyncIterable(readLines(), (cause) => cause).pipe(
    Stream.runForEach((command) =>
      command === "ping"
        ? connection.ping.pipe(Effect.andThen(Effect.sync(() => console.log(JSON.stringify({ type: "pong" })))))
        : command === "stall"
          ? Effect.sync(() => {
              const until = Date.now() + 1_100
              while (Date.now() < until) {}
            }).pipe(
              Effect.andThen(connection.ping),
              Effect.andThen(Effect.sync(() => console.log(JSON.stringify({ type: "stall-survived" })))),
            )
          : command === "reconnect-interactive"
            ? connection
                .run(
                  { _tag: "Interactive", prompt: [], ephemeral: false, workspace: process.cwd() },
                  {
                    interactive: (_, session) =>
                      Effect.gen(function* () {
                        let callbacks = 0
                        callbacks += 1
                        yield* Effect.sync(() =>
                          console.log(JSON.stringify({ type: "interactive-callback", callbacks })),
                        )
                        yield* session.initialize((event) =>
                          console.log(JSON.stringify({ type: "initial-read", tag: event._tag })),
                        )
                        yield* Effect.sync(() => process.kill(hostPid, "SIGKILL"))
                        yield* Effect.sleep("250 millis")
                        yield* session.initialize((event) =>
                          console.log(JSON.stringify({ type: "replacement-read", tag: event._tag })),
                        )
                        yield* session.submit("ambiguous", (event) => {
                          if (event._tag === "ExecutionFailed")
                            console.log(JSON.stringify({ type: "mutation-failed", tag: event._tag }))
                        })
                        yield* session.initialize((event) =>
                          console.log(JSON.stringify({ type: "post-mutation-read", tag: event._tag })),
                        )
                        yield* Effect.promise(async () => {
                          const attempts = (await Bun.file(join(dataRoot, "mutation-attempts.log")).text())
                            .trim()
                            .split("\n")
                          console.log(JSON.stringify({ type: "mutation-attempts", text: String(attempts.length) }))
                        })
                      }),
                  },
                )
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => console.log(JSON.stringify({ type: "reconnect-failed", error: error.message }))),
                  ),
                )
            : command === "interactive"
              ? connection
                  .run(
                    { _tag: "Interactive", prompt: [], ephemeral: false, workspace: process.cwd() },
                    {
                      interactive: (_, session) =>
                        Effect.sync(() => console.log(JSON.stringify({ type: "interactive-callback" }))).pipe(
                          Effect.andThen(
                            session.initialize((event) =>
                              console.log(JSON.stringify({ type: "interactive-event", tag: event._tag })),
                            ),
                          ),
                        ),
                    },
                  )
                  .pipe(
                    Effect.andThen(Effect.sync(() => console.log(JSON.stringify({ type: "interactive-completed" })))),
                  )
              : command === "rejected-interactive"
                ? connection
                    .run(
                      {
                        _tag: "Interactive",
                        prompt: ["reject-before-start"],
                        ephemeral: false,
                        workspace: process.cwd(),
                      },
                      { interactive: () => Effect.void },
                    )
                    .pipe(
                      Effect.catch((error) =>
                        Effect.sync(() =>
                          console.log(JSON.stringify({ type: "interactive-rejected", error: error.message })),
                        ),
                      ),
                    )
                : command === "burst-interactive"
                  ? Effect.gen(function* () {
                      let count = 0
                      const exit = yield* Effect.exit(
                        connection.run(
                          {
                            _tag: "Interactive",
                            prompt: ["burst-events"],
                            ephemeral: false,
                            workspace: process.cwd(),
                          },
                          {
                            interactive: (_, session) =>
                              session.initialize(() => {
                                count += 1
                              }),
                          },
                        ),
                      )
                      yield* Effect.sync(() =>
                        console.log(
                          JSON.stringify(
                            exit._tag === "Success"
                              ? { type: "burst-completed", text: String(count) }
                              : { type: "burst-failed", error: String(exit.cause) },
                          ),
                        ),
                      )
                    })
                  : command === "blocking-interactive"
                    ? connection
                        .run(
                          { _tag: "Interactive", prompt: [], ephemeral: false, workspace: process.cwd() },
                          {
                            interactive: () =>
                              Effect.sync(() => console.log(JSON.stringify({ type: "interactive-callback" }))).pipe(
                                Effect.andThen(Effect.never),
                              ),
                          },
                        )
                        .pipe(
                          Effect.ensuring(
                            Effect.sync(() => console.log(JSON.stringify({ type: "blocking-completed" }))),
                          ),
                          Effect.forkChild,
                          Effect.asVoid,
                        )
                    : command === "cancel-action"
                      ? connection
                          .run(
                            { _tag: "Interactive", prompt: [], ephemeral: false, workspace: process.cwd() },
                            {
                              interactive: (_, session) =>
                                Effect.gen(function* () {
                                  const first = yield* Effect.forkChild(session.followSelected(() => undefined))
                                  yield* Effect.sleep("50 millis")
                                  yield* Fiber.interrupt(first)
                                  yield* session.followSelected((event) =>
                                    console.log(JSON.stringify({ type: "second-action-event", tag: event._tag })),
                                  )
                                }),
                            },
                          )
                          .pipe(
                            Effect.andThen(
                              Effect.sync(() => console.log(JSON.stringify({ type: "actions-completed" }))),
                            ),
                          )
                      : command === "output"
                        ? connection
                            .run(
                              { _tag: "Doctor" },
                              {
                                stdout: (text) =>
                                  Effect.sync(() => console.log(JSON.stringify({ type: "output", text }))),
                              },
                            )
                            .pipe(
                              Effect.andThen(
                                Effect.sync(() => console.log(JSON.stringify({ type: "output-completed" }))),
                              ),
                            )
                        : command === "delayed"
                          ? connection
                              .run({
                                _tag: "Run",
                                prompt: ["delayed"],
                                ephemeral: false,
                                streamJson: false,
                                streamJsonInput: false,
                                streamJsonThinking: false,
                              })
                              .pipe(
                                Effect.andThen(
                                  Effect.sync(() => console.log(JSON.stringify({ type: "delayed-completed" }))),
                                ),
                                Effect.catch((error) =>
                                  Effect.sync(() =>
                                    console.log(JSON.stringify({ type: "delayed-failed", error: error.message })),
                                  ),
                                ),
                              )
                          : command === "rejected"
                            ? connection.run({ _tag: "Doctor" }).pipe(
                                Effect.andThen(
                                  Effect.sync(() => console.log(JSON.stringify({ type: "rejected-work-completed" }))),
                                ),
                                Effect.catch((error) =>
                                  Effect.sync(() =>
                                    console.log(JSON.stringify({ type: "rejected-work", error: error.message })),
                                  ),
                                ),
                              )
                            : command === "close"
                              ? connection.close.pipe(
                                  Effect.andThen(Effect.sync(() => console.log(JSON.stringify({ type: "closed" })))),
                                )
                              : Effect.void,
    ),
  )
})

BunRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.provide(BunServices.layer),
    Effect.provide(BunCrypto.layer),
    Effect.provide(Logger.layer([])),
  ),
)
