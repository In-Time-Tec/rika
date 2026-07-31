import { Deferred, Effect, Option, Queue, Ref, Schema, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class FixtureProcessError extends Schema.TaggedErrorClass<FixtureProcessError>()("FixtureProcessError", {
  message: Schema.String,
}) {}

const ResponseJson = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    pid: Schema.optional(Schema.Finite),
    ok: Schema.optional(Schema.Boolean),
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.String),
  }),
)
const encodeRequest = Schema.encodeEffect(Schema.UnknownFromJsonString)

const takePending = (
  pending: Ref.Ref<ReadonlyMap<string, Deferred.Deferred<unknown, FixtureProcessError>>>,
  id: string,
) =>
  Ref.modify(pending, (current) => {
    const waiter = current.get(id)
    if (waiter === undefined) return [Option.none(), current] as const
    const next = new Map(current)
    next.delete(id)
    return [Option.some(waiter), next] as const
  })

const failPending = (
  pending: Ref.Ref<ReadonlyMap<string, Deferred.Deferred<unknown, FixtureProcessError>>>,
  error: FixtureProcessError,
) =>
  Ref.getAndSet(pending, new Map()).pipe(
    Effect.flatMap((waiters) =>
      Effect.forEach(waiters.values(), (waiter) => Deferred.fail(waiter, error), { discard: true }),
    ),
  )

export interface FixtureProcess {
  readonly ready: Effect.Effect<number, FixtureProcessError>
  readonly request: <A>(
    schema: Schema.Codec<A, unknown, never, never>,
    type: string,
    value?: unknown,
  ) => Effect.Effect<A, FixtureProcessError>
  readonly kill: Effect.Effect<void, FixtureProcessError>
}

export interface FixtureProcessOptions {
  readonly script: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly label: string
}

export const spawnFixtureProcess: (
  options: FixtureProcessOptions,
) => Effect.Effect<FixtureProcess, FixtureProcessError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =
  Effect.fn("RuntimeTest.spawnFixtureProcess")(function* (options) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const input = yield* Queue.bounded<string>(128)
    const ready = yield* Deferred.make<number, FixtureProcessError>()
    const pending = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<unknown, FixtureProcessError>>>(new Map())
    const sequence = yield* Ref.make(0)
    const handle = yield* spawner
      .spawn(
        ChildProcess.make("bun", [options.script], {
          env: options.environment,
          extendEnv: true,
          stdin: { stream: Stream.fromQueue(input).pipe(Stream.encodeText), endOnDone: true },
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      .pipe(Effect.mapError((cause) => FixtureProcessError.make({ message: String(cause) })))

    yield* handle.stderr.pipe(Stream.runDrain, Effect.forkScoped)
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Schema.decodeUnknownEffect(ResponseJson)(line).pipe(
          Effect.mapError((cause) => FixtureProcessError.make({ message: String(cause) })),
          Effect.flatMap((message) =>
            Effect.gen(function* () {
              if (message.type === "ready" && message.pid !== undefined) yield* Deferred.succeed(ready, message.pid)
              if (message.id === undefined) return
              const waiter = yield* takePending(pending, message.id)
              if (Option.isNone(waiter)) return
              if (message.ok === true) yield* Deferred.succeed(waiter.value, message.value)
              else
                yield* Deferred.fail(
                  waiter.value,
                  FixtureProcessError.make({ message: message.error ?? `${options.label} request failed` }),
                )
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    )
    yield* handle.exitCode.pipe(
      Effect.flatMap((exitCode) => {
        const error = FixtureProcessError.make({ message: `${options.label} exited with code ${exitCode}` })
        return Effect.all([Deferred.fail(ready, error), failPending(pending, error)], { discard: true })
      }),
      Effect.forkScoped,
    )

    const request = Effect.fn("RuntimeTest.fixtureRequest")(function* <A>(
      schema: Schema.Codec<A, unknown, never, never>,
      type: string,
      value?: unknown,
    ) {
      const id = yield* Ref.getAndUpdate(sequence, (current) => current + 1).pipe(
        Effect.map((current) => `request-${current + 1}`),
      )
      const waiter = yield* Deferred.make<unknown, FixtureProcessError>()
      yield* Ref.update(pending, (current) => new Map(current).set(id, waiter))
      const encoded = yield* encodeRequest({ id, type, value }).pipe(
        Effect.mapError((cause) => FixtureProcessError.make({ message: String(cause) })),
      )
      yield* Queue.offer(input, `${encoded}\n`)
      return yield* Schema.decodeUnknownEffect(schema)(yield* Deferred.await(waiter)).pipe(
        Effect.mapError((cause) => FixtureProcessError.make({ message: String(cause) })),
      )
    })
    const kill = handle.kill({ killSignal: "SIGKILL" }).pipe(
      Effect.mapError((cause) => FixtureProcessError.make({ message: String(cause) })),
      Effect.andThen(handle.exitCode.pipe(Effect.ignore)),
    )
    return { ready: Deferred.await(ready), request, kill } satisfies FixtureProcess
  })
