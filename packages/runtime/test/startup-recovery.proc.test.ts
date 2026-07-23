import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { FixtureProcessError, spawnFixtureProcess } from "./process-protocol"

const script = new URL("./startup-recovery-process.ts", import.meta.url).pathname
const rootId = "execution:turn-recovery"

const Started = Schema.Struct({ started: Schema.Boolean })
const Inspection = Schema.Struct({
  status: Schema.String,
  pendingToolCount: Schema.Finite,
  children: Schema.Array(Schema.Struct({ executionId: Schema.String, status: Schema.String })),
})
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const runNative = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof BunServices.layer>>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        return yield* effect.pipe(Effect.provide(services))
      }),
    ),
  )

const startHost = (database: string, workspace: string, phase: string) =>
  spawnFixtureProcess({
    script,
    label: `startup recovery fixture (${phase})`,
    environment: {
      RIKA_RECOVERY_DATABASE: database,
      RIKA_RECOVERY_WORKSPACE: workspace,
      RIKA_RECOVERY_PHASE: phase,
    },
  })

interface EventRow {
  readonly type: string
  readonly sequence: number
  readonly data_json: string | null
  readonly content_json: string | null
}

interface Snapshot {
  readonly rootStatus: string | undefined
  readonly rootEvents: ReadonlyArray<EventRow>
  readonly children: ReadonlyArray<{ readonly id: string; readonly status: string }>
  readonly runningRootToolCalls: number
  readonly rootChatCheckpoints: number
  readonly epochs: ReadonlyArray<{ readonly execution_id: string; readonly baseline: string }>
}

const snapshot = (database: string): Effect.Effect<Snapshot, FixtureProcessError> =>
  Effect.try({
    try: () => {
      const connection = new Database(database, { readonly: true })
      try {
        return {
          rootStatus: connection
            .query<{ readonly status: string }, [string]>("select status from relay_executions where id = ?")
            .get(rootId)?.status,
          rootEvents: connection
            .query<
              EventRow,
              [string]
            >("select type, sequence, data_json, content_json from relay_execution_events where execution_id = ? order by sequence")
            .all(rootId),
          children: connection
            .query<
              { readonly id: string; readonly status: string },
              []
            >("select id, status from relay_executions where id like 'child:%' order by id")
            .all(),
          runningRootToolCalls:
            connection
              .query<
                { readonly total: number },
                [string]
              >("select count(*) as total from relay_tool_calls where execution_id = ? and state = 'running'")
              .get(rootId)?.total ?? 0,
          rootChatCheckpoints:
            connection
              .query<
                { readonly total: number },
                [string]
              >("select count(*) as total from relay_agent_chats where execution_id = ?")
              .get(rootId)?.total ?? 0,
          epochs: connection
            .query<
              { readonly execution_id: string; readonly baseline: string },
              []
            >("select execution_id, baseline from relay_execution_context_epochs order by execution_id")
            .all(),
        }
      } finally {
        connection.close()
      }
    },
    catch: (cause) => FixtureProcessError.make({ message: String(cause) }),
  })

function waitFor<A>(
  read: Effect.Effect<A, FixtureProcessError>,
  accept: (value: A) => boolean,
  description: string,
  remaining = 4_000,
): Effect.Effect<A, FixtureProcessError> {
  return Effect.gen(function* () {
    const value = yield* read.pipe(Effect.orElseSucceed((): A | undefined => undefined))
    if (value !== undefined && accept(value)) return value
    if (remaining === 0)
      return yield* FixtureProcessError.make({
        message: `timed out waiting for ${description}: ${value === undefined ? "unreadable" : encodeJson(value)}`,
      })
    yield* Effect.sleep("25 millis")
    return yield* Effect.suspend(() => waitFor(read, accept, description, remaining - 1))
  })
}

const count = (events: ReadonlyArray<EventRow>, type: string) => events.filter((event) => event.type === type).length

const startedWork = (event: EventRow) =>
  ["tool.call.", "tool.result.", "child_run.", "child_fan_out."].some((prefix) => event.type.startsWith(prefix))

test(
  "resident replacement before the first checkpoint fails the root safely, keeps children single-spawned, reconciles attempts, and releases admission",
  () =>
    runNative(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-startup-recovery-" })
          const database = path.join(directory, "relay.sqlite")

          const initial = yield* startHost(database, directory, "initial")
          yield* initial.ready
          expect(
            yield* initial.request(Started, "start", {
              threadId: "thread-recovery",
              turnId: "turn-recovery",
              prompt: "Explore alpha, beta, gamma, and delta.",
            }),
          ).toEqual({ started: true })

          const midFlight = yield* waitFor(
            snapshot(database),
            (state) =>
              count(state.rootEvents, "child_run.spawned") === 4 &&
              state.children.length === 4 &&
              state.children.every((child) => child.status === "running") &&
              state.runningRootToolCalls === 4 &&
              state.epochs.length === 5,
            "four running delegated children with pinned context epochs before any checkpoint",
          )
          expect(midFlight.rootChatCheckpoints).toBe(0)
          expect(count(midFlight.rootEvents, "execution.started")).toBe(1)
          const pinnedBaselines = new Map(midFlight.epochs.map((epoch) => [epoch.execution_id, epoch.baseline]))
          expect(pinnedBaselines.get(rootId)).toBeDefined()
          const requestedToolCalls = count(midFlight.rootEvents, "tool.call.requested")
          yield* initial.kill

          const replacement = yield* startHost(database, directory, "replacement")
          yield* replacement.ready

          const failed = yield* waitFor(
            snapshot(database),
            (state) => state.rootStatus === "failed" && state.rootEvents.at(-1)?.type === "execution.failed",
            "root execution failing safely after recovery",
          )
          const settled = yield* waitFor(
            snapshot(database),
            (state) => state.children.every((child) => child.status === "completed"),
            "delegated children completing after recovery",
          )

          expect(count(failed.rootEvents, "execution.started")).toBe(2)
          expect(count(failed.rootEvents, "child_run.spawned")).toBe(4)
          expect(count(failed.rootEvents, "tool.call.requested")).toBe(requestedToolCalls)
          const secondStart = failed.rootEvents.filter((event) => event.type === "execution.started")[1]
          expect(secondStart).toBeDefined()
          expect(
            failed.rootEvents.filter((event) => event.sequence > (secondStart?.sequence ?? 0)).some(startedWork),
          ).toBe(false)
          const last = failed.rootEvents.at(-1)
          expect(last?.type).toBe("execution.failed")
          const failure = `${last?.data_json ?? ""}${last?.content_json ?? ""}`
          expect(failure).toContain("recovered before its first durable checkpoint")
          expect(failure).not.toContain("Context epoch")

          expect(settled.children).toHaveLength(4)
          for (const epoch of settled.epochs) {
            expect(epoch.baseline, epoch.execution_id).toBe(pinnedBaselines.get(epoch.execution_id))
          }
          expect(settled.epochs).toHaveLength(pinnedBaselines.size)
          expect(settled.runningRootToolCalls).toBe(4)

          const inspection = yield* replacement.request(Inspection, "inspect", "turn-recovery")
          expect(inspection.status).toBe("failed")
          expect(inspection.pendingToolCount).toBe(0)
          expect(inspection.children).toHaveLength(4)
          expect(inspection.children.every((child) => child.status === "completed")).toBe(true)

          expect(
            yield* replacement.request(Started, "start", {
              threadId: "thread-recovery",
              turnId: "turn-recovery-2",
              prompt: "Summarize what happened.",
            }),
          ).toEqual({ started: true })
          yield* waitFor(
            Effect.try({
              try: () => {
                const connection = new Database(database, { readonly: true })
                try {
                  return connection
                    .query<{ readonly status: string }, [string]>("select status from relay_executions where id = ?")
                    .get("execution:turn-recovery-2")?.status
                } finally {
                  connection.close()
                }
              },
              catch: (cause) => FixtureProcessError.make({ message: String(cause) }),
            }),
            (status) => status === "completed",
            "a follow-up execution completing after admission release",
          )
          const followUp = yield* replacement.request(Inspection, "inspect", "turn-recovery-2")
          expect(followUp.status).toBe("completed")
          expect(followUp.pendingToolCount).toBe(0)
        }),
      ),
    ),
  300_000,
)
