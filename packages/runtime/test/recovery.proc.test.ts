import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { FixtureProcessError, spawnFixtureProcess } from "./process-protocol"

const script = new URL("./recovery-process.ts", import.meta.url).pathname
const rootId = "execution:turn-recovery"

const runNative = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof BunServices.layer>>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        return yield* effect.pipe(Effect.provide(services))
      }),
    ),
  )

function waitFor<A>(
  read: Effect.Effect<A, FixtureProcessError>,
  accept: (value: A) => boolean,
  remaining = 2_000,
): Effect.Effect<A, FixtureProcessError> {
  return Effect.gen(function* () {
    const value = yield* read
    if (accept(value)) return value
    if (remaining === 0) return yield* FixtureProcessError.make({ message: `recovery state did not settle` })
    yield* Effect.sleep("20 millis")
    return yield* Effect.suspend(() => waitFor(read, accept, remaining - 1))
  })
}

test(
  "resident replacement before the first chat checkpoint fails the root safely and preserves delegated outcomes",
  () =>
    runNative(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-recovery-" })
          const databaseFile = path.join(directory, "relay.db")
          const startHost = (phase: string) =>
            spawnFixtureProcess({
              script,
              label: "recovery fixture",
              environment: {
                RIKA_RECOVERY_DATABASE: databaseFile,
                RIKA_RECOVERY_WORKSPACE: directory,
                RIKA_RECOVERY_PHASE: phase,
              },
            })
          const query = <A>(sql: string) =>
            Effect.try({
              try: () => {
                const database = new Database(databaseFile, { readonly: true })
                try {
                  return database.query<A, []>(sql).all()
                } finally {
                  database.close()
                }
              },
              catch: (error) => FixtureProcessError.make({ message: String(error) }),
            })
          let host = yield* startHost("initial")
          const firstPid = yield* host.ready
          yield* host.request(Schema.String, "start").pipe(Effect.forkScoped)
          yield* waitFor(
            query<{ count: number }>(
              `select count(*) as count from relay_child_executions where execution_id = '${rootId}'`,
            ),
            (rows) => rows[0]?.count === 3,
          )
          const baseline = (yield* query<{ baseline: string }>(
            `select baseline from relay_execution_context_epochs where execution_id = '${rootId}'`,
          ))[0]?.baseline
          expect(baseline).toBeTypeOf("string")
          yield* host.kill
          host = yield* startHost("recovered-delayed")
          expect(yield* host.ready).not.toBe(firstPid)
          yield* waitFor(
            Effect.all({
              starts: query<{ count: number }>(
                `select count(*) as count from relay_execution_events where execution_id = '${rootId}' and type = 'execution.started'`,
              ),
              prepared: query<{ count: number }>(
                `select count(*) as count from relay_execution_events where execution_id = '${rootId}' and type = 'model.input.prepared'`,
              ),
            }),
            ({ starts, prepared }) => starts[0]?.count === 2 && prepared[0]?.count === 2,
          )
          yield* host.kill
          host = yield* startHost("recovered")
          expect(yield* host.ready).not.toBe(firstPid)
          const settled = yield* waitFor(
            Effect.all({
              root: query<{ status: string }>(`select status from relay_executions where id = '${rootId}'`),
              children: query<{ id: string; status: string }>(
                `select id, status from relay_executions where id like 'child:%' order by id`,
              ),
              cancelled: query<{ count: number }>(
                `select count(*) as count from relay_execution_events where execution_id = '${rootId}' and type = 'execution.cancelled'`,
              ),
            }),
            ({ root, children, cancelled }) =>
              root[0]?.status === "cancelled" &&
              children.length === 3 &&
              children.every((child) => child.status === "completed") &&
              cancelled[0]?.count === 1,
          )
          expect(settled.children).toHaveLength(3)
          expect(new Set(settled.children.map((child) => child.id)).size).toBe(3)
          const starts = yield* query<{ count: number }>(
            `select count(*) as count from relay_execution_events where execution_id = '${rootId}' and type = 'execution.started'`,
          )
          const prepared = yield* query<{ count: number }>(
            `select count(*) as count from relay_execution_events where execution_id = '${rootId}' and type = 'model.input.prepared'`,
          )
          const delegationCalls = yield* query<{ count: number }>(
            `select count(*) as count from relay_tool_calls where execution_id = '${rootId}' and name = 'task'`,
          )
          const attempts = yield* query<{ state: string; completed_at: number | null }>(
            `select state, completed_at from relay_tool_attempts where execution_id = '${rootId}' order by tool_call_id`,
          )
          const childOutcomes = yield* query<{ execution_id: string; content_json: string }>(
            `select execution_id, content_json from relay_execution_events where execution_id like 'child:%' and type = 'model.output.completed' order by execution_id`,
          )
          const recoveredBaseline = (yield* query<{ baseline: string }>(
            `select baseline from relay_execution_context_epochs where execution_id = '${rootId}'`,
          ))[0]?.baseline
          expect(starts[0]?.count).toBe(3)
          expect(prepared[0]?.count).toBe(3)
          expect(delegationCalls[0]?.count).toBe(3)
          expect(attempts).toHaveLength(3)
          expect(attempts.every((attempt) => attempt.state !== "running" && attempt.completed_at !== null)).toBe(true)
          expect(childOutcomes).toHaveLength(3)
          expect(childOutcomes.every((outcome) => outcome.content_json.includes("recovered child"))).toBe(true)
          expect(recoveredBaseline).toBe(baseline)
          expect(settled.cancelled[0]?.count).toBe(1)
          expect(yield* host.request(Schema.String, "start", "turn-after-recovery")).toBe("completed")
        }),
      ),
    ),
  300_000,
)
