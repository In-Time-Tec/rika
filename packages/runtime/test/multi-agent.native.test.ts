import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { FixtureProcessError, spawnFixtureProcess } from "./process-protocol"

const script = new URL("../../app/test/multi-agent-process.ts", import.meta.url).pathname

const runNative = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof BunServices.layer>>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        return yield* effect.pipe(Effect.provide(services))
      }),
    ),
  )

const Inspection = Schema.UndefinedOr(
  Schema.Struct({
    state: Schema.optional(Schema.String),
    members: Schema.optional(Schema.Array(Schema.Struct({ ordinal: Schema.Finite }))),
  }),
)
const RunResult = Schema.Union([Inspection, Schema.Undefined])
const Projection = Schema.Array(Schema.Struct({ childId: Schema.String, state: Schema.String }))
const VisibleRow = Schema.Struct({
  type: Schema.String,
  fanOutId: Schema.optional(Schema.String),
  childId: Schema.optional(Schema.String),
})
const VisibleRowJson = Schema.fromJsonString(VisibleRow)
const ReleaseJson = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    output: Schema.Array(Schema.TaggedStruct("text", { text: Schema.String })),
    completedAt: Schema.Finite,
  }),
)

const startHost = (database: string, workspace: string) =>
  spawnFixtureProcess({
    script,
    label: "multi-agent fixture",
    environment: { RIKA_MULTI_AGENT_DATABASE: database, RIKA_MULTI_AGENT_WORKSPACE: workspace },
  })

function waitFor<A>(
  read: Effect.Effect<A, FixtureProcessError>,
  accept: (value: A) => boolean,
  remaining = 500,
): Effect.Effect<A, FixtureProcessError> {
  return Effect.gen(function* () {
    if (remaining === 0)
      return yield* FixtureProcessError.make({ message: "timed out waiting for Rika multi-agent state" })
    const value = yield* read
    if (accept(value)) return value
    yield* Effect.sleep("20 millis")
    return yield* Effect.suspend(() => waitFor(read, accept, remaining - 1))
  })
}

const input = (name: string, joinPolicy: "all" | "first-success" | "quorum" | "best-effort", count = 4) => ({
  parentTurnId: `parent-${name}`,
  fanOutId: `fan-out:rika:${name}`,
  tasks: Array.from({ length: count }, (_, ordinal) => ({ id: `${name}-${ordinal}`, prompt: `task ${ordinal}` })),
  maxConcurrency: 2,
  join: joinPolicy,
  ...(joinPolicy === "quorum" ? { quorum: 2 } : {}),
  createdAt: 100,
})

test(
  "Rika ProductAgent fan-outs survive process death without duplicate projections",
  () =>
    runNative(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-multi-agent-" })
          const database = path.join(directory, "relay.sqlite")
          const release = (name: string, ordinal: number, status = "completed") =>
            fileSystem.writeFileString(
              path.join(directory, `child:parent-${name}:${name}-${ordinal}.json`),
              Schema.encodeSync(ReleaseJson)({
                status,
                output: [{ _tag: "text", text: `output-${ordinal}` }],
                completedAt: 200 + ordinal,
              }),
            )
          const visible = fileSystem.readFileString(path.join(directory, "visible.ndjson")).pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((text) =>
              Effect.forEach(text.trim() === "" ? [] : text.trim().split("\n"), (line) =>
                Schema.decodeUnknownEffect(VisibleRowJson)(line),
              ),
            ),
            Effect.mapError((error) => FixtureProcessError.make({ message: String(error) })),
          )
          let host = yield* startHost(database, directory)
          const firstPid = yield* host.ready
          yield* host.request(RunResult, "run", input("restart", "all")).pipe(Effect.forkScoped)
          yield* waitFor(visible, (rows) => rows.filter((row) => row.type === "dispatch").length === 2)
          yield* host.kill

          host = yield* startHost(database, directory)
          expect(yield* host.ready).not.toBe(firstPid)
          yield* Effect.all(
            Array.from({ length: 4 }, (_, ordinal) => release("restart", ordinal)),
            { concurrency: "unbounded" },
          )
          const resumed = yield* waitFor(
            host.request(Inspection, "inspect", "fan-out:rika:restart"),
            (inspection) => inspection?.state === "satisfied",
          )
          expect((resumed?.members ?? []).map((member) => member.ordinal)).toEqual([0, 1, 2, 3])
          const projection = yield* host.request(Projection, "project", "fan-out:rika:restart")
          expect(new Set(projection.map((member) => member.childId)).size).toBe(4)
          expect(projection.every((member) => member.state === "completed")).toBe(true)

          const cases = [
            ["all", ["completed", "completed", "completed"]],
            ["first-success", ["failed", "completed", "failed"]],
            ["quorum", ["completed", "failed", "completed"]],
            ["best-effort", ["failed", "completed", "cancelled"]],
          ] as const
          for (const [policy, statuses] of cases) {
            yield* host.request(RunResult, "run", input(policy, policy, 3))
            yield* Effect.all(
              statuses.map((status, ordinal) => release(policy, ordinal, status)),
              { concurrency: "unbounded" },
            )
            const completed = yield* waitFor(
              host.request(Inspection, "inspect", `fan-out:rika:${policy}`),
              (inspection) => inspection !== undefined && inspection.state !== "joining",
            )
            expect(completed?.state).toBe("satisfied")
            expect((completed?.members ?? []).map((member) => member.ordinal)).toEqual([0, 1, 2])
          }

          const pending = input("cancel", "all", 3)
          yield* host.request(RunResult, "run", pending).pipe(Effect.forkScoped)
          yield* waitFor(
            host.request(Inspection, "inspect", pending.fanOutId),
            (inspection) => inspection?.state === "joining",
          )
          const cancelled = yield* host.request(Inspection, "cancel", {
            id: pending.fanOutId,
            at: 300,
            reason: "parent cancelled",
          })
          expect(cancelled?.state).toBe("cancelled")
          expect((yield* host.request(Inspection, "cancel", { id: pending.fanOutId, at: 301 }))?.state).toBe(
            "cancelled",
          )
          const effects = (yield* visible).filter((row) => row.type === "effect")
          expect(new Set(effects.map((row) => `${row.fanOutId}:${row.childId}`)).size).toBe(effects.length)
        }),
      ),
    ),
  120_000,
)
