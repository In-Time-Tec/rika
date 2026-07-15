import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "bun:test"
import { Deferred, Effect, FileSystem, Layer, Path, Schema } from "effect"

const script = new URL("./workflow-process.ts", import.meta.url).pathname

class FixtureError extends Schema.TaggedErrorClass<FixtureError>()("WorkflowTestFixtureError", {
  message: Schema.String,
}) {}

const Message = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Finite),
  ok: Schema.optional(Schema.Boolean),
  value: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
})
const Pin = Schema.Struct({ name: Schema.String, revision: Schema.Finite, digest: Schema.String })
const Pins = Schema.Array(Pin)
const State = Schema.Struct({ status: Schema.String, revision: Schema.Finite, digest: Schema.String })
const Row = Schema.Struct({
  type: Schema.String,
  childId: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
})
const Rows = Schema.Array(Row)
const decodeMessage = Schema.decodeEffect(Schema.fromJsonString(Message))
const encodeRequest = Schema.encodeEffect(Schema.UnknownFromJsonString)

const runNative = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof BunServices.layer>>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        return yield* effect.pipe(Effect.provide(services))
      }),
    ),
  )

const startHost = Effect.fn("WorkflowTest.startHost")(function* (database: string, workspace: string) {
  const proc = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn([process.execPath, script], {
        cwd: process.cwd(),
        env: { ...process.env, RIKA_WORKFLOW_DATABASE: database, RIKA_WORKFLOW_WORKSPACE: workspace },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    ),
    (process) =>
      Effect.sync(() => void (process.exitCode === null && process.signalCode === null && process.kill("SIGKILL"))),
  )
  const ready = yield* Deferred.make<number, FixtureError>()
  const pending = new Map<string, Deferred.Deferred<unknown, FixtureError>>()
  const reader = proc.stdout.getReader()
  let sequence = 0
  let buffer = ""
  const consume: Effect.Effect<void, FixtureError> = Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => reader.read(),
      catch: (error) => FixtureError.make({ message: String(error) }),
    }).pipe(Effect.orElseSucceed(() => ({ done: true as const, value: undefined })))
    if (result.done) return
    buffer += new TextDecoder().decode(result.value)
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const message = yield* decodeMessage(buffer.slice(0, newline)).pipe(
        Effect.mapError((error) => FixtureError.make({ message: String(error) })),
      )
      buffer = buffer.slice(newline + 1)
      if (message.type === "ready" && message.pid !== undefined) yield* Deferred.succeed(ready, message.pid)
      if (message.id !== undefined) {
        const waiter = pending.get(message.id)
        if (waiter !== undefined) {
          pending.delete(message.id)
          if (message.ok === true) yield* Deferred.succeed(waiter, message.value)
          else yield* Deferred.fail(waiter, FixtureError.make({ message: message.error ?? "request failed" }))
        }
      }
      newline = buffer.indexOf("\n")
    }
    yield* Effect.suspend(() => consume)
  })
  yield* consume.pipe(Effect.forkScoped)
  const request = Effect.fn("WorkflowTest.request")(function* <A>(
    schema: Schema.Codec<A>,
    type: string,
    value?: unknown,
  ) {
    const id = `request-${++sequence}`
    const deferred = yield* Deferred.make<unknown, FixtureError>()
    pending.set(id, deferred)
    const encoded = yield* encodeRequest({ id, type, value }).pipe(
      Effect.mapError((error) => FixtureError.make({ message: String(error) })),
    )
    proc.stdin.write(`${encoded}\n`)
    return yield* Schema.decodeUnknownEffect(schema)(yield* Deferred.await(deferred)).pipe(
      Effect.mapError((error) => FixtureError.make({ message: String(error) })),
    )
  })
  return { proc, ready: Deferred.await(ready), request }
})

function waitFor<A>(
  read: Effect.Effect<A, FixtureError>,
  accept: (value: A) => boolean,
  remaining = 1_000,
): Effect.Effect<A, FixtureError> {
  return Effect.gen(function* () {
    const value = yield* read
    if (accept(value)) return value
    if (remaining === 0) return yield* FixtureError.make({ message: "timed out waiting for Rika workflow state" })
    yield* Effect.sleep("20 millis")
    return yield* Effect.suspend(() => waitFor(read, accept, remaining - 1))
  })
}

for (const scenario of [
  { name: "delivery", first: "child:workflow:delivery-run:delivery:investigate", count: 5 },
  {
    name: "research-synthesis",
    first: "workflow:workflow:research-synthesis-run:fan-out:research:member:research:oracle",
    count: 3,
  },
]) {
  test(
    `${scenario.name} pins its definition and survives SIGKILL without duplicate effects`,
    () =>
      runNative(
        Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workflow-" })
            const database = path.join(directory, "relay.sqlite")
            const rows = fileSystem.readFileString(path.join(directory, "workflow-visible.ndjson")).pipe(
              Effect.orElseSucceed(() => ""),
              Effect.flatMap((text) =>
                Schema.decodeUnknownEffect(Rows)(
                  text.trim() === ""
                    ? []
                    : text
                        .trim()
                        .split("\n")
                        .filter(Boolean)
                        .map((line) => JSON.parse(line)),
                ),
              ),
              Effect.mapError((error) => FixtureError.make({ message: String(error) })),
            )
            const release = (childId: string) =>
              fileSystem
                .writeFileString(path.join(directory, `${childId.replaceAll(":", "-")}.release`), "")
                .pipe(Effect.mapError((error) => FixtureError.make({ message: String(error) })))
            let host = yield* startHost(database, directory)
            const firstPid = yield* host.ready
            const registrations = yield* host.request(Pins, "register")
            const pin = registrations.find((item) => item.name === scenario.name)
            if (pin === undefined) return yield* FixtureError.make({ message: `missing ${scenario.name} registration` })
            expect(pin.revision).toBe(1)
            expect(pin.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
            yield* host
              .request(Schema.Unknown, "start", {
                name: scenario.name,
                runId: `${scenario.name}-run`,
                revision: pin.revision,
              })
              .pipe(Effect.forkScoped)
            yield* waitFor(rows, (items) => items.some((item) => item.type === "dispatch"))
            if (scenario.name === "research-synthesis") {
              const dispatches = (yield* rows).filter((row) => row.type === "dispatch")
              yield* Effect.all(
                dispatches.map((row) => release(row.childId ?? "")),
                { concurrency: "unbounded" },
              )
              yield* waitFor(rows, (items) => items.filter((item) => item.type === "effect").length >= 2)
              yield* host.request(Schema.Unknown, "recover")
              yield* waitFor(rows, (items) => items.filter((item) => item.type === "dispatch").length >= 3)
            }
            host.proc.kill("SIGKILL")
            yield* Effect.promise(() => host.proc.exited)
            host = yield* startHost(database, directory)
            expect(yield* host.ready).not.toBe(firstPid)
            const duplicatePin = (yield* host.request(Pins, "register")).find((item) => item.name === scenario.name)
            expect(duplicatePin).toEqual(pin)
            const completed = yield* waitFor(
              Effect.gen(function* () {
                const dispatched = (yield* rows).filter((item) => item.type === "dispatch")
                yield* Effect.all(
                  dispatched.map((item) => release(item.childId ?? "")),
                  { concurrency: "unbounded" },
                )
                return yield* host.request(State, "inspect", `${scenario.name}-run`)
              }),
              (state) => state.status === "completed",
            )
            expect(completed.revision).toBe(pin.revision)
            expect(completed.digest).toBe(pin.digest)
            const visible = yield* rows
            const effects = visible.filter((item) => item.type === "effect")
            expect(effects).toHaveLength(scenario.count)
            expect(new Set(effects.map((item) => item.idempotencyKey)).size).toBe(scenario.count)
            expect(visible.some((item) => item.childId === scenario.first)).toBe(true)
          }),
        ),
      ),
    120_000,
  )
}
