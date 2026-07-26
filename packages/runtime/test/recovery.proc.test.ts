import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { FixtureProcessError, spawnFixtureProcess } from "./process-protocol"

const script = new URL("./recovery-process.ts", import.meta.url).pathname
const rootId = "execution:turn-recovery"
const nextRootId = "execution:turn-after-recovery"
const alphaChildId = `child:${encodeURIComponent(rootId)}:call-alpha`
const betaChildId = `child:${encodeURIComponent(rootId)}:call-beta`
const gammaChildId = `child:${encodeURIComponent(rootId)}:call-gamma`
const promptSecret = "PROMPT_SECRET_SENTINEL_206_207_209"
const initialSystemSecret = "SYSTEM_SECRET_SENTINEL_INITIAL_206_207_209"
const recoveredSystemSecret = "SYSTEM_SECRET_SENTINEL_RECOVERED_206_207_209"
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const childIds = [alphaChildId, betaChildId, gammaChildId]
const stillPending = (status: string | undefined) => ["queued", "running", "waiting"].includes(status ?? "")
const settlesWithOneLateChild = (rows: ReadonlyArray<{ id: string; status: string }>) =>
  rows.length === 3 &&
  rows.every((row, index) => row.id === childIds[index]) &&
  rows.filter((row) => row.status === "completed").length === 2 &&
  rows.filter((row) => stillPending(row.status)).length === 1

const baselineHashAnnotations = (lines: ReadonlyArray<string>) =>
  lines.flatMap((line) => {
    const record: unknown = JSON.parse(line)
    if (record === null || typeof record !== "object" || !("annotations" in record)) return []
    const annotations = record.annotations
    if (annotations === null || typeof annotations !== "object" || !("rika.context.baseline.hash" in annotations))
      return []
    return [annotations["rika.context.baseline.hash"]]
  })

const baselineHashes = (lines: ReadonlyArray<string>) =>
  baselineHashAnnotations(lines).filter((hash): hash is string => typeof hash === "string")

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
  remaining = 5_000,
): Effect.Effect<A, FixtureProcessError> {
  return Effect.gen(function* () {
    const value = yield* read
    if (accept(value)) return value
    if (remaining === 0)
      return yield* FixtureProcessError.make({ message: `recovery state did not settle: ${encodeJson(value)}` })
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
          const databaseFile = path.join(directory, "execution.db")
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
          const initialLogs = yield* waitFor(host.request(Schema.Array(Schema.String), "logs"), (lines) =>
            baselineHashes(lines).some((hash) => /^[a-f0-9]{64}$/.test(hash)),
          )
          const initialHash = baselineHashes(initialLogs).at(-1)
          yield* host.kill
          host = yield* startHost("recovered-delayed")
          expect(yield* host.ready).not.toBe(firstPid)
          const repeatedRecoveryLogs = yield* waitFor(host.request(Schema.Array(Schema.String), "logs"), (lines) =>
            baselineHashes(lines).some((hash) => /^[a-f0-9]{64}$/.test(hash)),
          )
          const delayedSettle = yield* waitFor(
            Effect.all({
              children: query<{ id: string; status: string }>(
                `select id, status from relay_executions where id in ('${alphaChildId}', '${betaChildId}', '${gammaChildId}') order by id`,
              ),
              childRuns: query<{ id: string; status: string }>(
                `select id, status from relay_child_executions where execution_id = '${rootId}' order by id`,
              ),
            }),
            ({ children, childRuns }) =>
              settlesWithOneLateChild(children) &&
              settlesWithOneLateChild(childRuns) &&
              children.find((row) => stillPending(row.status))?.id ===
                childRuns.find((row) => stillPending(row.status))?.id,
          )
          const lateChildId = delayedSettle.children.find((row) => stillPending(row.status))?.id
          const repeatedRecoveryHash = baselineHashes(repeatedRecoveryLogs).at(-1)
          yield* host.kill
          host = yield* startHost("recovered-stuck")
          expect(yield* host.ready).not.toBe(firstPid)
          const settled = yield* waitFor(
            Effect.all({
              root: query<{ status: string }>(`select status from relay_executions where id = '${rootId}'`),
              children: query<{ id: string; status: string }>(
                `select id, status from relay_executions where id like 'child:%' order by id`,
              ),
              childRuns: query<{ id: string; status: string }>(
                `select id, status from relay_child_executions where execution_id = '${rootId}' order by id`,
              ),
              cancelled: query<{ count: number }>(
                `select count(*) as count from relay_execution_events where execution_id = '${rootId}' and type = 'execution.cancelled'`,
              ),
            }),
            ({ root, children, childRuns, cancelled }) =>
              root[0]?.status === "cancelled" &&
              children.length === 3 &&
              children.filter((child) => child.status === "completed").length === 2 &&
              children.filter((child) => child.status === "cancelled").length === 1 &&
              childRuns.length === 3 &&
              childRuns.filter((child) => child.status === "completed").length === 2 &&
              childRuns.filter((child) => child.status === "cancelled").length === 1 &&
              cancelled[0]?.count === 1,
          )
          const expectedDelegatedOutcomes = childIds.map((id) => ({
            id,
            status: id === lateChildId ? "cancelled" : "completed",
          }))
          expect(settled.children).toHaveLength(3)
          expect(settled.children).toEqual(expectedDelegatedOutcomes)
          expect(settled.childRuns).toHaveLength(3)
          expect(settled.childRuns).toEqual(expectedDelegatedOutcomes)
          const starts = yield* query<{ count: number }>(
            `select count(*) as count from relay_execution_events where execution_id = '${rootId}' and type = 'execution.started'`,
          )
          const prepared = yield* query<{ count: number }>(
            `select count(*) as count from relay_execution_events where execution_id = '${rootId}' and type = 'model.input.prepared'`,
          )
          const delegationCalls = yield* query<{ id: string; name: string; state: string }>(
            `select id, name, state from relay_tool_calls where execution_id = '${rootId}' order by id`,
          )
          const pendingDelegationCalls = yield* query<{ count: number }>(
            `select count(*) as count from relay_tool_calls where execution_id = '${rootId}' and state not in ('completed', 'failed', 'cancelled')`,
          )
          const delegationResults = yield* query<{ tool_call_id: string; error: string | null }>(
            `select result.tool_call_id, result.error from relay_tool_results result join relay_tool_calls call on call.id = result.tool_call_id where call.execution_id = '${rootId}' order by result.tool_call_id`,
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
          const epochFailures = yield* query<{ count: number }>(
            `select count(*) as count from relay_execution_events where execution_id = '${rootId}' and type = 'execution.failed'`,
          )
          expect(starts[0]?.count).toBe(1)
          expect(prepared[0]?.count).toBe(1)
          expect(delegationCalls).toEqual([
            { id: "call-alpha", name: "task", state: "failed" },
            { id: "call-beta", name: "task", state: "failed" },
            { id: "call-gamma", name: "task", state: "failed" },
          ])
          expect(pendingDelegationCalls[0]?.count).toBe(0)
          expect(delegationResults.map((result) => result.tool_call_id)).toEqual(delegationCalls.map((call) => call.id))
          expect(delegationResults.map((result) => result.error)).toEqual([
            "Tool execution cancelled",
            "Tool execution cancelled",
            "Tool execution cancelled",
          ])
          expect(attempts.map((attempt) => attempt.state)).toEqual(["failed", "failed", "failed"])
          expect(attempts.every((attempt) => attempt.completed_at !== null)).toBe(true)
          expect(childOutcomes.map((outcome) => outcome.execution_id)).toEqual(
            childIds.filter((id) => id !== lateChildId),
          )
          expect(childOutcomes.every((outcome) => outcome.content_json.includes("recovered child"))).toBe(true)
          expect(recoveredBaseline).toBe(baseline)
          expect(epochFailures[0]?.count).toBe(0)
          expect(settled.cancelled[0]?.count).toBe(1)
          const containedRecoveryLogs = yield* host.request(Schema.Array(Schema.String), "logs")
          const recoveredHash = baselineHashes(containedRecoveryLogs).at(-1)
          yield* host.kill
          host = yield* startHost("after-recovery")
          expect(yield* host.ready).not.toBe(firstPid)
          expect(yield* host.request(Schema.String, "start", "turn-after-recovery")).toBe("completed")
          const sessions = yield* query<{ id: string; session_id: string | null }>(
            `select id, session_id from relay_executions where id in ('${rootId}', '${nextRootId}') order by id`,
          )
          expect(sessions).toHaveLength(2)
          expect(sessions.map((execution) => execution.session_id)).toEqual([
            "session:thread-recovery",
            "session:thread-recovery",
          ])
          const cancellationAfterAdmission = yield* query<{ count: number }>(
            `select count(*) as count from relay_execution_events where execution_id = '${rootId}' and type = 'execution.cancelled'`,
          )
          expect(cancellationAfterAdmission[0]?.count).toBe(1)
          const finalLogs = yield* host.request(Schema.Array(Schema.String), "logs")
          expect(initialHash).toMatch(/^[a-f0-9]{64}$/)
          expect(repeatedRecoveryHash).toMatch(/^[a-f0-9]{64}$/)
          expect(recoveredHash).toMatch(/^[a-f0-9]{64}$/)
          expect(repeatedRecoveryHash).toBe(recoveredHash)
          expect(recoveredHash).not.toBe(initialHash)
          const capturedHashValues = baselineHashAnnotations([
            ...initialLogs,
            ...repeatedRecoveryLogs,
            ...containedRecoveryLogs,
            ...finalLogs,
          ])
          expect(capturedHashValues.length).toBeGreaterThan(0)
          expect(capturedHashValues.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))).toBe(true)
          expect(
            containedRecoveryLogs.some((line) => {
              const record = JSON.parse(line) as {
                readonly message?: unknown
                readonly annotations?: Readonly<Record<string, unknown>>
              }
              return (
                record.message === "execution.recovery.failed_safe" &&
                record.annotations?.["rika.recovery.children.settled"] === false
              )
            }),
          ).toBe(true)
          const capturedLogs = [...initialLogs, ...repeatedRecoveryLogs, ...containedRecoveryLogs, ...finalLogs].join(
            "\n",
          )
          expect(capturedLogs).not.toContain(promptSecret)
          expect(capturedLogs).not.toContain(initialSystemSecret)
          expect(capturedLogs).not.toContain(recoveredSystemSecret)
        }),
      ),
    ),
  300_000,
)
