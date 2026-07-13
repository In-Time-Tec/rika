import * as BunServices from "@effect/platform-bun/BunServices"
import { AiError, ModelResilience, Response } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Duration, Effect, Fiber, FileSystem, Schedule } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"

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

test("corrects unknown and malformed tool calls at the durable model boundary", async () => {
  const cases = [
    ["turn-unknown", "not_a_rika_tool", {}],
    ["turn-malformed", "read_file", { path: 42 }],
  ] as const
  const verifyCases = async (remaining: ReadonlyArray<(typeof cases)[number]>): Promise<void> => {
    if (remaining.length === 0) return
    const [turnId, name, params] = remaining[0]!
    const rest = remaining.slice(1)
    const outcome = await Effect.runPromise(
      withBackend([TestModel.toolCall(name, params, { id: turnId }), TestModel.text("corrected")], (fixture) =>
        Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          const result = yield* backend.start({ threadId: turnId, turnId, prompt: "call tool", startedAt: 1 })
          return { result, requests: yield* fixture.requests }
        }),
      ),
    )
    expect(outcome.result.status).toBe("completed")
    expect(
      outcome.result.events
        .filter((event) => event.type === "model.output.delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("corrected")
    expect(outcome.requests).toHaveLength(2)
    await verifyCases(rest)
  }
  await verifyCases(cases)
}, 30_000)

test("preserves a canonical terminal failure after more than one thousand execution events", async () => {
  const result = await Effect.runPromise(
    withBackend(
      [
        ...Array.from({ length: 260 }, (_, index) =>
          TestModel.toolCall("read_file", { path: "fixture.txt" }, { id: `read-${index}` }),
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          TestModel.toolCall("not_a_rika_tool", {}, { id: `late-invalid-tool-${index}` }),
        ),
      ],
      (_, directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "fixture")
          const backend = yield* ExecutionBackend.Service
          return yield* backend.start({
            threadId: "thread-late-failure",
            turnId: "turn-late-failure",
            prompt: "stream before failing",
            startedAt: 1,
          })
        }),
    ),
  )
  const failures = result.events.filter((event) => event.type === "execution.failed")
  expect(result.events.length).toBeGreaterThan(1_000)
  expect(result.status).toBe("failed")
  expect(failures).toHaveLength(1)
  expect(failures[0]?.data?.message).toBe(failures[0]?.text)
  expect(failures[0]?.text).toContain("not_a_rika_tool")
}, 120_000)

test("settles a Rika fan-out child after more than one thousand execution events", async () => {
  const childText = `${"x".repeat(1_100)}CHILD_OK`
  const childOutput = `${childText}{"type":"structured","value":{"summary":"CHILD_OK","files":[]},"schema_ref":"rika.agent.task.v1"}`
  const result = await Effect.runPromise(
    withBackend(
      [
        TestModel.text("parent ready"),
        TestModel.turn([...Array.from({ length: 1_100 }, () => TestModel.text("x")), TestModel.text("CHILD_OK")]),
        TestModel.object({ summary: "CHILD_OK", files: [] }),
      ],
      (_, directory) =>
        Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          yield* backend.start({
            threadId: "thread-long-child",
            turnId: "turn-long-child-parent",
            prompt: "prepare fan-out",
            startedAt: 1,
          })
          yield* backend.createFanOut({
            parentTurnId: "turn-long-child-parent",
            fanOutId: "fan-out:long-child",
            children: [{ childId: "long-child", prompt: "produce the child result" }],
            maxConcurrency: 1,
            join: "all",
            createdAt: 2,
          })
          const fanOut = yield* backend.inspectFanOut("fan-out:long-child").pipe(
            Effect.repeat({
              while: (inspection) => inspection?.state === "joining",
              schedule: Schedule.both(Schedule.spaced("20 millis"), Schedule.recurs(500)),
            }),
          )
          const database = new Database(`${directory}/relay.db`, { readonly: true })
          const childExecutions = database
            .query<
              { readonly id: string; readonly status: string },
              []
            >("select id, status from relay_executions where id = 'child:long-child'")
            .all()
          const childEventCount =
            database
              .query<
                { readonly count: number },
                []
              >("select count(*) as count from relay_execution_events where execution_id = 'child:long-child'")
              .get()?.count ?? 0
          database.close()
          return { fanOut, childExecutions, childEventCount }
        }),
    ),
  )
  expect(result.fanOut?.state).toBe("satisfied")
  expect(result.childExecutions).toEqual([{ id: "child:long-child", status: "completed" }])
  expect(result.childEventCount).toBeGreaterThan(1_000)
  expect(result.fanOut?.members).toEqual([
    {
      childId: "long-child",
      ordinal: 0,
      state: "completed",
      output: childOutput,
    },
  ])
}, 60_000)

test("executes concurrent fan-out members with their persisted main and Oracle model routes", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-routes-" })
        const main = yield* TestModel.make(
          [
            TestModel.text("parent-main"),
            TestModel.text("child-main"),
            TestModel.object({ summary: "child-main", files: [] }),
          ],
          {
            provider: "main-provider",
            model: "main-model",
          },
        )
        const oracle = yield* TestModel.make(
          [TestModel.text("child-oracle"), TestModel.object({ answer: "child-oracle", evidence: [] })],
          {
            provider: "oracle-provider",
            model: "oracle-model",
          },
        )
        return yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          yield* backend.start({
            threadId: "thread-routes",
            turnId: "turn-routes-parent",
            prompt: "prepare fan-out",
            startedAt: 1,
          })
          yield* backend.createFanOut({
            parentTurnId: "turn-routes-parent",
            fanOutId: "fan-out:routes",
            children: [
              { childId: "oracle-route", profile: "Oracle", prompt: "ask Oracle" },
              { childId: "main-route", profile: "Task", prompt: "ask main" },
            ],
            maxConcurrency: 2,
            join: "all",
            createdAt: 2,
          })
          const fanOut = yield* backend.inspectFanOut("fan-out:routes").pipe(
            Effect.repeat({
              while: (inspection) => inspection?.state === "joining",
              schedule: Schedule.both(Schedule.spaced("20 millis"), Schedule.recurs(500)),
            }),
          )
          return {
            fanOut,
            mainRequests: yield* main.requests,
            oracleRequests: yield* oracle.requests,
          }
        }).pipe(
          Effect.provide(
            RelayExecutionBackend.layer({
              filename: `${directory}/relay.db`,
              workspace: directory,
              registration: main.registration,
              additionalRegistrations: [oracle.registration],
              selection: main.selection,
              oracleSelection: oracle.selection,
            }),
          ),
        )
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  )
  expect(result.fanOut?.state).toBe("satisfied")
  expect(result.fanOut?.members.map((member) => member.output)).toEqual([
    'child-oracle{"type":"structured","value":{"answer":"child-oracle","evidence":[]},"schema_ref":"rika.agent.oracle.v1"}',
    'child-main{"type":"structured","value":{"summary":"child-main","files":[]},"schema_ref":"rika.agent.task.v1"}',
  ])
  expect(result.mainRequests).toHaveLength(3)
  expect(result.oracleRequests).toHaveLength(2)
  expect(JSON.stringify(result.mainRequests[1]?.prompt)).toContain("ask main")
  expect(JSON.stringify(result.oracleRequests[0]?.prompt)).toContain("ask Oracle")
}, 60_000)

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
          const execution = yield* backend.start({
            threadId: "thread-budget",
            turnId: "turn-budget",
            prompt: "read",
            startedAt: 1,
          })
          return { execution, requests: yield* fixture.requests }
        }),
      { tokenBudget: 1 },
    ),
  )
  const budgetExceeded = result.execution.events.find((event) => event.type === "budget.exceeded")
  const failed = result.execution.events.find((event) => event.type === "execution.failed")
  expect(result.execution.status).toBe("failed")
  expect(budgetExceeded).toMatchObject({
    type: "budget.exceeded",
    data: { tokens_used: 4, token_budget: 1 },
  })
  expect(failed).toMatchObject({
    type: "execution.failed",
    text: "AgentLoopBudgetExceeded: used 4 of 1 tokens",
    data: { message: "AgentLoopBudgetExceeded: used 4 of 1 tokens" },
  })
  expect(failed?.content).toBeUndefined()
  expect(budgetExceeded!.sequence).toBeLessThan(failed!.sequence)
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
          compaction: { contextWindow: 100, reserveTokens: 1, keepRecentTokens: 10 },
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
}, 60_000)

test("cancels an in-flight model through Relay", async () => {
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
}, 30_000)

for (const answer of ["Approved", "Denied", "Always"] as const) {
  test(`resumes a durable permission wait after restart with ${answer} and no duplicate tool effects`, async () => {
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
          const completed = yield* useBackend(
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              yield* backend.resolvePermission(waitId, answer, 2, "test decision")
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
  }, 60_000)
}

test("thread host entity wakes on a delivered promotion and invokes the registered promoter", async () => {
  const program = withBackend([], (_fixture) =>
    Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      const promoted: Array<string> = []
      yield* backend.registerTurnPromoter!((threadId) =>
        Effect.sync(() => {
          promoted.push(threadId)
          return 1
        }),
      )
      yield* backend.ensureThreadHost!("thread-host-native", 1)
      yield* backend.ensureThreadHost!("thread-host-native", 2)
      yield* backend.notifyThreadHost!("thread-host-native", "turn-native-1", 3)
      yield* backend.notifyThreadHost!("thread-host-native", "turn-native-1", 4)
      yield* Effect.suspend(() =>
        promoted.length > 0 ? Effect.void : Effect.fail(new Error("promoter not invoked yet")),
      ).pipe(Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: 100 }))
      return promoted
    }),
  )
  const promoted = await Effect.runPromise(program as Effect.Effect<Array<string>>)
  expect(promoted).toEqual(["thread-host-native"])
}, 60_000)
