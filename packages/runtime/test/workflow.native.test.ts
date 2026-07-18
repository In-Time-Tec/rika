import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { FixtureProcessError, spawnFixtureProcess } from "./process-protocol"

const script = new URL("./workflow-process.ts", import.meta.url).pathname

const Pin = Schema.Struct({ name: Schema.String, revision: Schema.Finite, digest: Schema.String })
const Pins = Schema.Array(Pin)
const State = Schema.Struct({ status: Schema.String, revision: Schema.Finite, digest: Schema.String })
const Row = Schema.Struct({
  type: Schema.String,
  childId: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
})
const RowJson = Schema.fromJsonString(Row)

const runNative = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof BunServices.layer>>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        return yield* effect.pipe(Effect.provide(services))
      }),
    ),
  )

const startHost = (database: string, workspace: string) =>
  spawnFixtureProcess({
    script,
    label: "workflow fixture",
    environment: { RIKA_WORKFLOW_DATABASE: database, RIKA_WORKFLOW_WORKSPACE: workspace },
  })

function waitFor<A>(
  read: Effect.Effect<A, FixtureProcessError>,
  accept: (value: A) => boolean,
  remaining = 1_000,
): Effect.Effect<A, FixtureProcessError> {
  return Effect.gen(function* () {
    const value = yield* read
    if (accept(value)) return value
    if (remaining === 0)
      return yield* FixtureProcessError.make({ message: "timed out waiting for Rika workflow state" })
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
                Effect.forEach(text.trim() === "" ? [] : text.trim().split("\n").filter(Boolean), (line) =>
                  Schema.decodeUnknownEffect(RowJson)(line),
                ),
              ),
              Effect.mapError((error) => FixtureProcessError.make({ message: String(error) })),
            )
            const release = (childId: string) =>
              fileSystem
                .writeFileString(path.join(directory, `${childId.replaceAll(":", "-")}.release`), "")
                .pipe(Effect.mapError((error) => FixtureProcessError.make({ message: String(error) })))
            let host = yield* startHost(database, directory)
            const firstPid = yield* host.ready
            const registrations = yield* host.request(Pins, "register")
            const pin = registrations.find((item) => item.name === scenario.name)
            if (pin === undefined)
              return yield* FixtureProcessError.make({ message: `missing ${scenario.name} registration` })
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
            yield* host.kill
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
