import * as BunServices from "@effect/platform-bun/BunServices"
import { LanguageModel, ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Runtime } from "@rika/tools"
import { describe, expect, it, test } from "vitest"
import { Database } from "bun:sqlite"
import { Deferred, Effect, Fiber, FileSystem, Layer, Ref, Schedule, Stream } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { planJoin } from "../src/subagent-join"
import { start } from "./current-execution-route"

const encodeJson = (value: unknown) => JSON.stringify(value)

const executionModelRoute = (
  role: ExecutionBackend.ExecutionModelRoute["role"],
  selection: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
): ExecutionBackend.ExecutionModelRoute => ({
  role,
  alias: role,
  provider: selection.provider,
  model: selection.model,
  registrationKey: selection.registrationKey ?? role,
  providerProtocol: "test",
  providerBaseUrl: "test://model",
  effort: "medium",
  fast: false,
  requestVariant: selection.registrationKey ?? role,
  compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
})

describe("planJoin", () => {
  it("separates pending children from terminal children", () => {
    const plan = planJoin(
      [
        { childExecutionId: "child-a", status: "completed" },
        { childExecutionId: "child-b", status: "running" },
      ],
      undefined,
    )
    expect(plan).toEqual([
      { _tag: "terminal", childExecutionId: "child-a" },
      { _tag: "pending", childExecutionId: "child-b" },
    ])
  })

  it("keeps the requested order and drops duplicate requests", () => {
    const plan = planJoin(
      [
        { childExecutionId: "child-a", status: "completed" },
        { childExecutionId: "child-b", status: "failed" },
      ],
      ["child-b", "child-a", "child-b"],
    )
    expect(plan.map((target) => target.childExecutionId)).toEqual(["child-b", "child-a"])
  })

  it("marks a requested identifier that is not a child of this execution as unknown", () => {
    const plan = planJoin([{ childExecutionId: "child-a", status: "completed" }], ["child-z"])
    expect(plan).toEqual([{ _tag: "unknown", childExecutionId: "child-z" }])
  })

  it("selects nothing when the execution has no children", () => {
    expect(planJoin([], undefined)).toEqual([])
  })
})

test("a delegation returns a running handle and await_subagents collects the report", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-join-" })
      const main = yield* TestModel.make(
        [
          TestModel.toolCall("oracle", { prompt: "Investigate the boundary." }, { id: "call-oracle" }),
          TestModel.toolCall("await_subagents", {}, { id: "call-join" }),
          TestModel.text("Root synthesized the child answer."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" },
      )
      const oracle = yield* TestModel.make([TestModel.text("Oracle investigated the boundary.")], {
        provider: "test",
        model: "gpt-5.6-sol",
        registrationKey: "sol-medium",
      })
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: main.registration,
        additionalRegistrations: [oracle.registration],
        selection: main.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-join",
          turnId: "turn-join",
          prompt: "Ask the Oracle to investigate the boundary.",
          startedAt: 1,
          executionRoute: {
            mode: "test",
            main: executionModelRoute("main", main.selection),
            oracle: executionModelRoute("oracle", oracle.selection),
          },
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const results = database
          .query<
            { readonly name: string; readonly output_json: string; readonly error: string | null },
            []
          >("select call.name, result.output_json, result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.execution_id = 'execution:turn-join' order by call.created_at")
          .all()
        return { settled, results }
      }).pipe(Effect.provide(backendContext))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bunContext = yield* Layer.build(BunServices.layer)
        return yield* program.pipe(Effect.provide(bunContext))
      }),
    ).pipe(
      Effect.tap(({ settled, results }) =>
        Effect.sync(() => {
          const spawn = results.find((result) => result.name === "oracle")
          const join = results.find((result) => result.name === "await_subagents")
          expect(settled.status, encodeJson(settled.events.filter((event) => event.type === "execution.failed"))).toBe(
            "completed",
          )
          expect(spawn?.error).toBeNull()
          expect(spawn?.output_json).toContain('"_tag":"Spawned"')
          expect(spawn?.output_json).toContain('"status":"running"')
          expect(join?.error).toBeNull()
          expect(join?.output_json).toContain("Oracle investigated the boundary.")
          expect(join?.output_json).toContain('"_tag":"Report"')
        }),
      ),
    ),
  )
}, 60_000)

test("await_subagents suspends on an open child and resumes when the child terminates", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-join-suspend-" })
      const main = yield* TestModel.make(
        [
          TestModel.toolCall("oracle", { prompt: "Investigate slowly." }, { id: "call-oracle" }),
          TestModel.toolCall("await_subagents", {}, { id: "call-join" }),
          TestModel.text("Root collected the held child."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" },
      )
      const child = yield* TestModel.make([TestModel.text("Held child reported.")], {
        provider: "test",
        model: "gpt-5.6-sol",
        registrationKey: "sol-medium",
      })
      const release = yield* Deferred.make<void>()
      const held = Layer.effect(
        LanguageModel.LanguageModel,
        Effect.gen(function* () {
          const model = yield* LanguageModel.LanguageModel
          const streamText = ((options: Parameters<LanguageModel.Service["streamText"]>[0]) =>
            Stream.unwrap(
              Deferred.await(release).pipe(Effect.as(model.streamText(options))),
            )) as LanguageModel.Service["streamText"]
          return { ...model, streamText }
        }),
      ).pipe(Layer.provide(child.layer))
      const childRegistration = yield* ModelRegistry.registration({ ...child.selection, layer: held })
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: main.registration,
        additionalRegistrations: [childRegistration],
        selection: main.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const running = yield* start(backend, {
          threadId: "thread-join-suspend",
          turnId: "turn-join-suspend",
          prompt: "Ask the Oracle to investigate slowly.",
          startedAt: 1,
          executionRoute: {
            mode: "test",
            main: executionModelRoute("main", main.selection),
            oracle: executionModelRoute("oracle", child.selection),
          },
        }).pipe(Effect.forkChild)
        const suspended = yield* backend.inspect("turn-join-suspend").pipe(
          Effect.map(
            (inspection) =>
              inspection?.waits.some((wait) => wait.mode === "child") === true &&
              inspection.pendingTools.some((tool) => tool.name === "await_subagents"),
          ),
          Effect.repeat({ while: (found) => !found, schedule: Schedule.spaced("20 millis") }),
          Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.succeed(false) }),
        )
        yield* Deferred.succeed(release, undefined)
        const settled = yield* Fiber.join(running)
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const attempts = database
          .query<
            { readonly count: number },
            []
          >("select count(*) as count from relay_tool_attempts attempt join relay_tool_calls call on call.id = attempt.tool_call_id and call.execution_id = attempt.execution_id where call.name = 'await_subagents'")
          .get()
        const join = database
          .query<
            { readonly output_json: string; readonly error: string | null },
            []
          >("select result.output_json, result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.name = 'await_subagents'")
          .get()
        return { suspended, settled, attempts, join }
      }).pipe(Effect.provide(backendContext))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bunContext = yield* Layer.build(BunServices.layer)
        return yield* program.pipe(Effect.provide(bunContext))
      }),
    ).pipe(
      Effect.tap(({ suspended, settled, attempts, join }) =>
        Effect.sync(() => {
          expect(suspended).toBe(true)
          expect(settled.status, encodeJson(settled.events.filter((event) => event.type === "execution.failed"))).toBe(
            "completed",
          )
          expect(attempts?.count).toBeGreaterThan(1)
          expect(join?.error).toBeNull()
          expect(join?.output_json).toContain("Held child reported.")
        }),
      ),
    ),
  )
}, 60_000)

test("a parent that answers without collecting its subagents cancels them", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-join-abandon-" })
      const main = yield* TestModel.make(
        [
          TestModel.toolCall("oracle", { prompt: "Investigate forever." }, { id: "call-oracle" }),
          TestModel.text("Answered without collecting the subagent."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" },
      )
      const child = yield* TestModel.make([TestModel.text("Never delivered.")], {
        provider: "test",
        model: "gpt-5.6-sol",
        registrationKey: "sol-medium",
      })
      const never = yield* Deferred.make<void>()
      const stalled = Layer.effect(
        LanguageModel.LanguageModel,
        Effect.gen(function* () {
          const model = yield* LanguageModel.LanguageModel
          const streamText = ((options: Parameters<LanguageModel.Service["streamText"]>[0]) =>
            Stream.unwrap(
              Deferred.await(never).pipe(Effect.as(model.streamText(options))),
            )) as LanguageModel.Service["streamText"]
          return { ...model, streamText }
        }),
      ).pipe(Layer.provide(child.layer))
      const childRegistration = yield* ModelRegistry.registration({ ...child.selection, layer: stalled })
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: main.registration,
        additionalRegistrations: [childRegistration],
        selection: main.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-join-abandon",
          turnId: "turn-join-abandon",
          prompt: "Ask the Oracle to investigate forever.",
          startedAt: 1,
          executionRoute: {
            mode: "test",
            main: executionModelRoute("main", main.selection),
            oracle: executionModelRoute("oracle", child.selection),
          },
        })
        const childStatus = yield* backend.inspect("turn-join-abandon").pipe(
          Effect.map((inspection) => inspection?.children[0]?.status),
          Effect.repeat({ while: (status) => status !== "cancelled", schedule: Schedule.spaced("20 millis") }),
          Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.succeed("timed out") }),
        )
        return { settled, childStatus }
      }).pipe(Effect.provide(backendContext))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bunContext = yield* Layer.build(BunServices.layer)
        return yield* program.pipe(Effect.provide(bunContext))
      }),
    ).pipe(
      Effect.tap(({ settled, childStatus }) =>
        Effect.sync(() => {
          expect(settled.status).toBe("completed")
          expect(childStatus).toBe("cancelled")
        }),
      ),
    ),
  )
}, 60_000)

test("delegations issued in separate model cycles run at the same time", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-join-parallel-" })
      const main = yield* TestModel.make(
        [
          TestModel.toolCall("oracle", { prompt: "Explore alpha." }, { id: "call-alpha" }),
          TestModel.toolCall("review", { prompt: "Explore beta." }, { id: "call-beta" }),
          TestModel.toolCall("await_subagents", {}, { id: "call-join" }),
          TestModel.text("Collected both explorations."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" },
      )
      const child = yield* TestModel.make([TestModel.text("alpha finished."), TestModel.text("beta finished.")], {
        provider: "test",
        model: "gpt-5.6-sol",
        registrationKey: "sol-medium",
      })
      const started = yield* Ref.make(0)
      const bothStarted = yield* Deferred.make<void>()
      const overlapping = Layer.effect(
        LanguageModel.LanguageModel,
        Effect.gen(function* () {
          const model = yield* LanguageModel.LanguageModel
          const streamText = ((options: Parameters<LanguageModel.Service["streamText"]>[0]) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const active = yield* Ref.updateAndGet(started, (value) => value + 1)
                if (active === 2) yield* Deferred.succeed(bothStarted, undefined)
                yield* Deferred.await(bothStarted)
                return model.streamText(options)
              }),
            )) as LanguageModel.Service["streamText"]
          return { ...model, streamText }
        }),
      ).pipe(Layer.provide(child.layer))
      const childRegistration = yield* ModelRegistry.registration({ ...child.selection, layer: overlapping })
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: main.registration,
        additionalRegistrations: [childRegistration],
        selection: main.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-join-parallel",
          turnId: "turn-join-parallel",
          prompt: "Explore alpha and beta.",
          startedAt: 1,
          executionRoute: {
            mode: "test",
            main: executionModelRoute("main", main.selection),
            oracle: executionModelRoute("oracle", child.selection),
          },
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const children = database
          .query<
            { readonly id: string; readonly status: string },
            []
          >("select id, status from relay_executions where id like 'child:%' order by id")
          .all()
        const join = database
          .query<
            { readonly output_json: string; readonly error: string | null },
            []
          >("select result.output_json, result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.name = 'await_subagents'")
          .get()
        return { settled, children, join }
      }).pipe(Effect.provide(backendContext))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bunContext = yield* Layer.build(BunServices.layer)
        return yield* program.pipe(Effect.provide(bunContext))
      }),
    ).pipe(
      Effect.tap(({ settled, children, join }) =>
        Effect.sync(() => {
          expect(settled.status, encodeJson(settled.events.filter((event) => event.type === "execution.failed"))).toBe(
            "completed",
          )
          expect(children).toHaveLength(2)
          expect(children.every((record) => record.status === "completed")).toBe(true)
          expect(join?.error).toBeNull()
          expect(join?.output_json).toContain("alpha finished.")
          expect(join?.output_json).toContain("beta finished.")
        }),
      ),
    ),
  )
}, 60_000)
