import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { ResidentService } from "@rika/app"
import {
  Clock,
  Config,
  Deferred,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Logger,
  Path,
  Ref,
  Schema,
  Stdio,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { make } from "../../src/resident-transport"

const JsonLine = Schema.UnknownFromJsonString
const HostStatus = Schema.fromJsonString(Schema.Struct({ hostPid: Schema.Finite }))

const program = Effect.gen(function* () {
  const dataRoot = yield* Config.string("RIKA_TEST_RESIDENT_DATA_ROOT")
  const grace = yield* Config.string("RIKA_TEST_RESIDENT_GRACE").pipe(Config.withDefault("500"))
  const finalizerDelay = yield* Config.string("RIKA_TEST_RESIDENT_FINALIZER_DELAY").pipe(Config.withDefault("0"))
  const delayedWork = yield* Config.string("RIKA_TEST_RESIDENT_DELAYED_WORK").pipe(Config.withDefault("0"))
  const stdio = yield* Stdio.Stdio
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const clock = yield* Clock.Clock
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const hostPid = yield* Ref.make(0)
  const emit = Effect.fn("ResidentClient.emit")(function* (value: unknown) {
    const encoded = yield* Schema.encodeUnknownEffect(JsonLine)(value)
    yield* Stream.make(`${encoded}\n`).pipe(Stream.run(stdio.stdout({ endOnDone: false })))
  }, Effect.orDie)
  const kill = Effect.fn("ResidentClient.kill")(
    function* (pid: number) {
      const killer = yield* spawner.spawn(ChildProcess.make("kill", ["-KILL", String(pid)]))
      yield* killer.exitCode
    },
    Effect.scoped,
    Effect.orDie,
  )
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
          const handle = yield* spawner.spawn(
            ChildProcess.make("bun", ["test/fixtures/resident-host.ts"], {
              cwd: path.dirname(path.dirname(import.meta.dir)),
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              extendEnv: true,
              env: {
                RIKA_TEST_RESIDENT_DATA_ROOT: dataRoot,
                RIKA_TEST_RESIDENT_GRACE: grace,
                RIKA_TEST_RESIDENT_FINALIZER_DELAY: finalizerDelay,
                RIKA_TEST_RESIDENT_DELAYED_WORK: delayedWork,
              },
            }),
          )
          const reref = yield* handle.unref
          void reref
        }).pipe(
          Effect.mapError((cause) =>
            ResidentService.ResidentServiceError.make({
              reason: "transport-failed",
              message: String(cause),
            }),
          ),
        ),
    }),
  )
  if (connected._tag === "Failure") {
    yield* emit({ type: "rejected", error: connected.failure.message })
    return
  }
  const connection = connected.success
  yield* Effect.addFinalizer(() => connection.close)
  yield* connection.run(
    { _tag: "Doctor" },
    {
      stdout: (text) =>
        Schema.decodeUnknownEffect(HostStatus)(text).pipe(
          Effect.flatMap((status) => Ref.set(hostPid, status.hostPid)),
          Effect.orDie,
        ),
    },
  )
  yield* emit({
    type: "attached",
    role: connection.role,
    id: connection.connectionId,
    clientPid: process.pid,
    hostPid: yield* Ref.get(hostPid),
  })
  const commands = stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
  )
  const done = yield* Deferred.make<void>()
  yield* Effect.raceFirst(
    commands.pipe(
      Stream.runForEach((command) => {
        const workspace = path.dirname(path.dirname(import.meta.dir))
        if (command === "ping") return connection.ping.pipe(Effect.andThen(emit({ type: "pong" })))
        if (command === "stall")
          return Effect.sync(() => {
            const until = clock.currentTimeMillisUnsafe() + 1_100
            while (clock.currentTimeMillisUnsafe() < until) {}
          }).pipe(Effect.andThen(connection.ping), Effect.andThen(emit({ type: "stall-survived" })))
        if (command === "reconnect-interactive")
          return connection
            .run(
              { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
              {
                interactive: (_, session) =>
                  Effect.gen(function* () {
                    yield* emit({ type: "interactive-callback", callbacks: 1 })
                    const initial = new Array<string>()
                    yield* session.initialize((event) => initial.push(event._tag))
                    yield* Effect.forEach(initial, (tag) => emit({ type: "initial-read", tag }), { discard: true })
                    const pid = yield* Ref.get(hostPid)
                    yield* kill(pid)
                    yield* Effect.sleep("250 millis")
                    const replacement = new Array<string>()
                    yield* session.initialize((event) => replacement.push(event._tag))
                    yield* Effect.forEach(replacement, (tag) => emit({ type: "replacement-read", tag }), {
                      discard: true,
                    })
                    const mutation = new Array<string>()
                    yield* session.submit("ambiguous", (event) => {
                      if (event._tag === "ExecutionFailed") mutation.push(event._tag)
                    })
                    yield* Effect.forEach(mutation, (tag) => emit({ type: "mutation-failed", tag }), { discard: true })
                    const postMutation = new Array<string>()
                    yield* session.initialize((event) => postMutation.push(event._tag))
                    yield* Effect.forEach(postMutation, (tag) => emit({ type: "post-mutation-read", tag }), {
                      discard: true,
                    })
                    const attempts = (yield* fs
                      .readFileString(path.join(dataRoot, "mutation-attempts.log"))
                      .pipe(Effect.orDie))
                      .trim()
                      .split("\n")
                    yield* emit({ type: "mutation-attempts", text: String(attempts.length) })
                  }),
              },
            )
            .pipe(Effect.catch((error) => emit({ type: "reconnect-failed", error: error.message })))
        if (command === "interactive")
          return connection
            .run(
              { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
              {
                interactive: (_, session) =>
                  Effect.gen(function* () {
                    yield* emit({ type: "interactive-callback" })
                    const events = new Array<string>()
                    yield* session.initialize((event) => events.push(event._tag))
                    yield* Effect.forEach(events, (tag) => emit({ type: "interactive-event", tag }), { discard: true })
                  }),
              },
            )
            .pipe(Effect.andThen(emit({ type: "interactive-completed" })))
        if (command === "rejected-interactive")
          return connection
            .run(
              { _tag: "Interactive", prompt: ["reject-before-start"], ephemeral: false, workspace },
              { interactive: () => Effect.void },
            )
            .pipe(Effect.catch((error) => emit({ type: "interactive-rejected", error: error.message })))
        if (command === "burst-interactive")
          return Effect.gen(function* () {
            const count = yield* Ref.make(0)
            const context = yield* Effect.context()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["burst-events"], ephemeral: false, workspace },
                {
                  interactive: (_, session) =>
                    session.initialize(() => Effect.runSyncWith(context)(Ref.update(count, (value) => value + 1))),
                },
              ),
            )
            yield* emit(
              exit._tag === "Success"
                ? { type: "burst-completed", text: String(yield* Ref.get(count)) }
                : { type: "burst-failed", error: String(exit.cause) },
            )
          })
        if (command === "overflow-interactive")
          return Effect.gen(function* () {
            const tags = new Array<string>()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["overflow-events"], ephemeral: false, workspace },
                {
                  interactive: (_, session) => session.initialize((event) => tags.push(event._tag)),
                },
              ),
            )
            yield* emit({
              type: exit._tag === "Failure" ? "overflow-failed" : "overflow-completed",
              callbacks: tags.length,
              tag: tags.at(-1),
              tags,
              ...(exit._tag === "Failure" ? { error: String(exit.cause) } : {}),
            })
          })
        if (command === "overflow-watch")
          return Effect.gen(function* () {
            const tags = new Array<string>()
            const exit = yield* Effect.exit(
              connection.run(
                { _tag: "Interactive", prompt: ["overflow-watch"], ephemeral: false, workspace },
                {
                  interactive: (_, session) => session.watchThreads((event) => tags.push(event._tag)),
                },
              ),
            )
            yield* emit({
              type: "overflow-watch-finished",
              outcome: exit._tag,
              tags,
            })
          })
        if (command === "blocking-interactive")
          return connection
            .run(
              { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
              { interactive: () => emit({ type: "interactive-callback" }).pipe(Effect.andThen(Effect.never)) },
            )
            .pipe(Effect.ensuring(emit({ type: "blocking-completed" })), Effect.forkChild, Effect.asVoid)
        if (command === "cancel-action")
          return connection
            .run(
              { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
              {
                interactive: (_, session) =>
                  Effect.gen(function* () {
                    const first = yield* Effect.forkChild(session.followSelected(() => undefined))
                    yield* Effect.sleep("50 millis")
                    yield* Fiber.interrupt(first)
                    const events = new Array<string>()
                    yield* session.followSelected((event) => events.push(event._tag))
                    yield* Effect.forEach(events, (tag) => emit({ type: "second-action-event", tag }), {
                      discard: true,
                    })
                  }),
              },
            )
            .pipe(Effect.andThen(emit({ type: "actions-completed" })))
        if (command === "output")
          return connection
            .run({ _tag: "Doctor" }, { stdout: (text) => emit({ type: "output", text }) })
            .pipe(Effect.andThen(emit({ type: "output-completed" })))
        if (command === "delayed")
          return connection
            .run({
              _tag: "Run",
              prompt: ["delayed"],
              ephemeral: false,
              streamJson: false,
              streamJsonInput: false,
              streamJsonThinking: false,
            })
            .pipe(
              Effect.andThen(emit({ type: "delayed-completed" })),
              Effect.catch((error) => emit({ type: "delayed-failed", error: error.message })),
            )
        if (command === "rejected")
          return connection.run({ _tag: "Doctor" }).pipe(
            Effect.andThen(emit({ type: "rejected-work-completed" })),
            Effect.catch((error) => emit({ type: "rejected-work", error: error.message })),
          )
        if (command === "close")
          return connection.close.pipe(
            Effect.andThen(emit({ type: "closed" })),
            Effect.andThen(Deferred.succeed(done, undefined)),
          )
        return Effect.void
      }),
    ),
    Deferred.await(done),
  )
})

const MainLayer = Layer.mergeAll(BunServices.layer, Logger.layer([]))

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(MainLayer)
      yield* Effect.provide(program, context)
    }),
  ),
)
