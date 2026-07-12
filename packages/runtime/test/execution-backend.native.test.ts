import * as BunServices from "@effect/platform-bun/BunServices"
import { AiError, ModelResilience, Response } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { ContextUsage } from "@rika/app"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Duration, Effect, Fiber, FileSystem, Schedule } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"

const relaySuspendedWaitResumeAvailable = await import("@relayfx/sdk/sqlite").then(
  (module) => "ChildFanOutRuntime" in module,
)

const withBackend = <A, E>(
  script: Parameters<typeof TestModel.make>[0],
  run: (
    fixture: TestModel.Fixture,
    directory: string,
  ) => Effect.Effect<A, E, ExecutionBackend.Service | FileSystem.FileSystem>,
  options?: Pick<
    RelayExecutionBackend.LayerOptions,
    "modelResilience" | "compaction" | "tokenBudget" | "permissionPolicy"
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-" })
      const fixture = yield* TestModel.make(script)
      return yield* run(fixture, directory).pipe(
        Effect.provide(
          RelayExecutionBackend.layer({
            filename: `${directory}/relay.db`,
            workspace: directory,
            registration: fixture.registration,
            selection: fixture.selection,
            ...options,
          }),
        ),
      )
    }),
  ).pipe(Effect.provide(BunServices.layer))

test("completes idempotently and replays from a cursor", async () => {
  const program = withBackend([TestModel.text("deterministic answer")], (fixture) =>
    Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      const streamed: Array<ExecutionBackend.Event> = []
      const input = {
        threadId: "thread-a",
        turnId: "turn-a",
        prompt: "hello",
        startedAt: 1,
        onEvent: (event: ExecutionBackend.Event) => streamed.push(event),
      }
      const first = yield* backend.start(input)
      const { onEvent: _onEvent, ...duplicateInput } = input
      const duplicate = yield* backend.start(duplicateInput)
      const replay = yield* backend.replay(input.turnId)
      const cursor = replay.events.at(1)?.cursor
      const after = yield* backend.replay(input.turnId, cursor)
      return { first, duplicate, replay, after, streamed, requests: yield* fixture.requests }
    }),
  )
  const result = await Effect.runPromise(program)
  expect(result.first.status).toBe("completed")
  expect(result.first.events.map((event) => event.type)).toContain("model.output.completed")
  expect(result.streamed).toEqual([...result.first.events])
  expect(result.duplicate.events.map((event) => event.cursor)).toEqual(result.first.events.map((event) => event.cursor))
  expect(result.replay.events.map((event) => event.cursor)).toEqual(result.first.events.map((event) => event.cursor))
  expect(result.after.events[0]?.cursor).not.toBe(result.replay.events[0]?.cursor)
  expect(result.requests).toHaveLength(1)
}, 30_000)

test("executes the Rika toolkit through Relay and returns the result to Baton", async () => {
  const program = withBackend(
    [
      TestModel.turn([TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: "read-1" })]),
      TestModel.text("tool complete"),
    ],
    (fixture, directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "tool fixture")
        const backend = yield* ExecutionBackend.Service
        const result = yield* backend.start({
          threadId: "thread-tools",
          turnId: "turn-tools",
          prompt: "read fixture.txt",
          startedAt: 1,
        })
        return { result, requests: yield* fixture.requests }
      }),
  )
  const result = await Effect.runPromise(program)
  expect(result.result.status).toBe("completed")
  expect(result.requests).toHaveLength(2)
  expect(JSON.stringify(result.requests[1])).toContain("fixture.txt")
}, 30_000)

test("streams grouped model parts and persists usage through Relay SQLite", async () => {
  const usage = new Response.Usage({
    inputTokens: { uncached: 7, total: 7, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 3, text: 3, reasoning: undefined },
  })
  const result = await Effect.runPromise(
    withBackend([TestModel.turn([TestModel.text("group "), TestModel.text("stream")], { usage })], () =>
      Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const completed = yield* backend.start({
          threadId: "thread-stream",
          turnId: "turn-stream",
          prompt: "go",
          startedAt: 1,
        })
        return yield* backend.replay(completed.turnId)
      }),
    ),
  )
  expect(result.status).toBe("completed")
  expect(
    result.events
      .filter((event) => event.type === "model.output.delta")
      .map((event) => event.text)
      .join(""),
  ).toBe("group stream")
  expect(result.events.map((event) => event.type)).toContain("model.usage.reported")
}, 30_000)

test.skipIf(!("reasoning" in TestModel))(
  "projects and replays reasoning separately from assistant text",
  async () => {
    const result = await Effect.runPromise(
      withBackend([TestModel.turn([TestModel.reasoning("inspect state"), TestModel.text("final answer")])], () =>
        Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          const completed = yield* backend.start({
            threadId: "thread-reasoning",
            turnId: "turn-reasoning",
            prompt: "reason",
            startedAt: 1,
          })
          return { completed, replay: yield* backend.replay(completed.turnId) }
        }),
      ),
    )
    const reasoning = result.completed.events.filter((event) => event.type === "model.reasoning.delta")
    const assistant = result.completed.events.filter((event) => event.type === "model.output.delta")
    expect(reasoning.map((event) => event.text).join("")).toBe("inspect state")
    expect(assistant.map((event) => event.text).join("")).toBe("final answer")
    expect(reasoning[0]?.cursor).not.toBe(assistant[0]?.cursor)
    expect(result.replay.events).toEqual(result.completed.events)
  },
  30_000,
)

test("rejects unknown and malformed tool calls at the durable model boundary", async () => {
  const cases = [
    ["turn-unknown", "not_a_rika_tool", {}],
    ["turn-malformed", "read_file", { path: 42 }],
  ] as const
  const verifyCases = async (remaining: ReadonlyArray<(typeof cases)[number]>): Promise<void> => {
    if (remaining.length === 0) return
    const [turnId, name, params] = remaining[0]!
    const rest = remaining.slice(1)
    const result = await Effect.runPromise(
      withBackend([TestModel.toolCall(name, params, { id: turnId })], () =>
        Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          return yield* backend.start({ threadId: turnId, turnId, prompt: "call tool", startedAt: 1 })
        }).pipe(Effect.exit),
      ),
    )
    expect(result._tag).toBe("Failure")
    await verifyCases(rest)
  }
  await verifyCases(cases)
}, 30_000)

test("retries a transient TestModel failure inside the durable execution", async () => {
  const retryable = AiError.make({
    module: "test",
    method: "streamText",
    reason: new AiError.RateLimitError({}),
  })
  const program = withBackend(
    [TestModel.failure(retryable), TestModel.text("recovered")],
    (fixture) =>
      Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const result = yield* backend.start({
          threadId: "thread-retry",
          turnId: "turn-retry",
          prompt: "retry",
          startedAt: 1,
        })
        return { result, requests: yield* fixture.requests }
      }),
    { modelResilience: ModelResilience.make({ retrySchedule: Schedule.recurs(1) }) },
  )
  const result = await Effect.runPromise(program)
  expect(result.result.status).toBe("completed")
  expect(result.requests).toHaveLength(2)
  expect(
    result.result.events
      .filter((event) => event.type === "model.output.delta")
      .map((event) => event.text)
      .join(""),
  ).toBe("recovered")
}, 30_000)

test("accepts steering while a TestModel execution is active", async () => {
  const program = withBackend(
    [
      TestModel.turn([TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: "steer-read" })], {
        delay: Duration.millis(100),
      }),
      TestModel.text("steered"),
    ],
    (fixture, directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "fixture")
          const backend = yield* ExecutionBackend.Service
          const fiber = yield* Effect.forkScoped(
            backend.start({ threadId: "thread-steer", turnId: "turn-steer", prompt: "start", startedAt: 1 }),
          )
          yield* fixture.awaitRequests(1)
          yield* backend.steer("turn-steer", "focus on the fixture", 2)
          const result = yield* Fiber.join(fiber)
          return { result, requests: yield* fixture.requests }
        }),
      ),
  )
  const result = await Effect.runPromise(program)
  expect(result.result.status).toBe("completed")
  expect(result.requests).toHaveLength(2)
  expect(JSON.stringify(result.requests[0])).not.toContain("focus on the fixture")
  expect(JSON.stringify(result.requests[1]).match(/focus on the fixture/g)).toHaveLength(1)
}, 30_000)

test("exhausts the configured token budget before another model turn", async () => {
  const usage = new Response.Usage({
    inputTokens: { uncached: 2, total: 2, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined },
  })
  const result = await Effect.runPromise(
    withBackend(
      [
        TestModel.turn([TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: "budget-read" })], {
          usage,
        }),
        TestModel.text("must not be requested"),
      ],
      (fixture, directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "fixture")
          const backend = yield* ExecutionBackend.Service
          const exit = yield* backend
            .start({ threadId: "thread-budget", turnId: "turn-budget", prompt: "read", startedAt: 1 })
            .pipe(Effect.exit)
          return { exit, requests: yield* fixture.requests }
        }),
      { tokenBudget: 1 },
    ),
  )
  expect(result.exit._tag).toBe("Failure")
  expect(result.requests).toHaveLength(1)
}, 30_000)

test("persists automatic compaction across backend restart and reuses compacted context", async () => {
  const usage = new Response.Usage({
    inputTokens: { uncached: 200, total: 200, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  })
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-compaction-" })
        yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "sensitive fixture contents")
        const fixture = yield* TestModel.make([
          TestModel.turn([TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: "compact-read" })], {
            usage,
          }),
          TestModel.text("Goal: Finish the compacted run. The fixture was read. Continue with the durable checkpoint."),
          TestModel.text("compaction complete"),
        ])
        const filename = `${directory}/relay.db`
        const options = {
          filename,
          workspace: directory,
          registration: fixture.registration,
          selection: fixture.selection,
          compaction: { contextWindow: 100, reserveTokens: 0, keepRecentTokens: 10 },
        }
        const input = {
          threadId: "thread-compaction",
          turnId: "turn-compaction",
          prompt: "read fixture.txt and finish",
          startedAt: 1,
        }
        const run = <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
          effect.pipe(Effect.provide(RelayExecutionBackend.layer(options)))
        const completed = yield* run(
          Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            return yield* backend.start(input)
          }),
        )
        const database = new Database(filename, { readonly: true })
        const checkpoints = database
          .query("SELECT checkpoint_id, summary, turn FROM relay_agent_compactions WHERE execution_id = ?")
          .all("execution:turn-compaction") as ReadonlyArray<{ checkpoint_id: string; summary: string; turn: number }>
        database.close()
        const reopened = yield* run(
          Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            const duplicate = yield* backend.start(input)
            return { duplicate, replay: yield* backend.replay(input.turnId) }
          }),
        )
        const verifyDatabase = new Database(filename, { readonly: true })
        const checkpointCount = verifyDatabase
          .query("SELECT count(*) AS count FROM relay_agent_compactions WHERE execution_id = ?")
          .get("execution:turn-compaction") as { count: number }
        verifyDatabase.close()
        return {
          completed,
          reopened,
          checkpoints,
          checkpointCount: checkpointCount.count,
          requests: yield* fixture.requests,
        }
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  )
  expect(result.completed.status).toBe("completed")
  expect(result.checkpoints).toHaveLength(1)
  expect(result.checkpoints[0]?.checkpoint_id).toContain("compaction:execution:turn-compaction")
  expect(result.checkpoints[0]?.summary).toContain("Finish the compacted run")
  expect(result.checkpointCount).toBe(1)
  expect(result.reopened.duplicate.events).toEqual(result.reopened.replay.events)
  expect(result.requests).toHaveLength(3)
  expect(JSON.stringify(result.requests[1]?.prompt)).toContain("Summarize the conversation")
  expect(JSON.stringify(result.requests[2]?.prompt)).toContain("Finish the compacted run")
  expect(
    ContextUsage.analyze(200, {
      contextWindow: 100,
      reserveTokens: 0,
      keepRecentTokens: 10,
      toolOutputMaxBytes: 1_024,
    }),
  ).toMatchObject({
    contextTokens: 200,
    availableTokens: 100,
    shouldCompact: true,
  })
}, 60_000)

test.skipIf(!relaySuspendedWaitResumeAvailable)(
  "cancels an in-flight model through Relay",
  async () => {
    const program = withBackend([TestModel.turn([TestModel.text("late")], { delay: Duration.seconds(5) })], (fixture) =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          const fiber = yield* Effect.forkScoped(
            backend.start({ threadId: "thread-a", turnId: "turn-cancel", prompt: "wait", startedAt: 1 }),
          )
          yield* fixture.awaitRequests(1)
          const accepted = yield* backend.cancel("turn-cancel", 2)
          const completed = yield* Fiber.join(fiber)
          return { accepted, completed }
        }),
      ),
    )
    const result = await Effect.runPromise(program)
    expect(result.accepted.status).toBe("cancelled")
    expect(result.accepted.events.filter((event) => event.type === "execution.cancelled")).toHaveLength(1)
    expect(result.completed.status).toBe("cancelled")
    expect(result.completed.events.filter((event) => event.type === "execution.cancelled")).toHaveLength(1)
  },
  30_000,
)

for (const answer of ["Approved", "Denied", "Always"] as const) {
  test.skipIf(!relaySuspendedWaitResumeAvailable)(
    `resumes a durable permission wait after restart with ${answer} and no duplicate tool effects`,
    async () => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-permission-" })
            yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "permission fixture")
            const fixture = yield* TestModel.make([
              TestModel.turn([TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: `read-${answer}` })]),
              TestModel.text(`${answer} complete`),
            ])
            const options = {
              filename: `${directory}/relay.db`,
              workspace: directory,
              registration: fixture.registration,
              selection: fixture.selection,
              permissionPolicy: { rules: [{ pattern: "read_file", level: "ask" as const }] },
            }
            const useBackend = <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
              effect.pipe(Effect.provide(RelayExecutionBackend.layer(options)))
            const input = {
              threadId: `thread-${answer}`,
              turnId: `turn-${answer}`,
              prompt: "read fixture",
              startedAt: 1,
            }
            const waiting = yield* useBackend(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const started = yield* backend.start(input)
                const inspection = yield* backend.inspect(input.turnId)
                return { started, waits: inspection?.waits ?? [] }
              }),
            )
            expect(waiting.started.status).toBe("waiting")
            expect(waiting.waits).toHaveLength(1)
            const waitId = waiting.waits[0]!.id
            yield* useBackend(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                yield* backend.resolvePermission(waitId, answer, 2, "test decision")
              }),
            )
            const completed = yield* useBackend(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const resumed = yield* backend.start(input)
                const duplicate = yield* backend.start(input)
                const replay = yield* backend.replay(input.turnId)
                return { resumed, duplicate, replay, approvals: yield* backend.listApprovals(input.turnId) }
              }),
            )
            return { ...completed, requests: yield* fixture.requests }
          }),
        ).pipe(Effect.provide(BunServices.layer)),
      )
      expect(result.resumed.status).toBe("completed")
      expect(result.duplicate.status).toBe("completed")
      expect(result.approvals).toEqual([])
      expect(result.requests).toHaveLength(2)
      expect(result.replay.events.filter((event) => event.type === "tool.result.received")).toHaveLength(
        answer === "Denied" ? 0 : 1,
      )
      expect(result.replay.events.map((event) => event.cursor)).toEqual(
        result.duplicate.events.map((event) => event.cursor),
      )
    },
    60_000,
  )
}
