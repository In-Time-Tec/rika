import * as BunServices from "@effect/platform-bun/BunServices"

import { TestModel } from "@batonfx/test"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"

import * as RelayExecutionBackend from "../src/relay/execution/relay-execution-layer"

import { start } from "./current-execution-route"

import { fixture as testSupport } from "./subagent-join-fixture"
const { encodeJson, executionModelRoute } = testSupport
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
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-join",
          turnId: "turn-join",
          prompt: "Ask the Oracle to investigate the boundary.",
          executionRoute: {
            version: 1 as const,
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
test("a silent subagent is collected as a no-report verdict", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-join-silent-" })
      const main = yield* TestModel.make(
        [
          TestModel.toolCall("oracle", { prompt: "Say nothing." }, { id: "call-oracle" }),
          TestModel.toolCall("await_subagents", {}, { id: "call-join" }),
          TestModel.text("Root noticed the empty report."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" },
      )
      const oracle = yield* TestModel.make([TestModel.turn([])], {
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
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-join-silent",
          turnId: "turn-join-silent",
          prompt: "Ask the Oracle to say nothing.",
          executionRoute: {
            version: 1 as const,
            mode: "test",
            main: executionModelRoute("main", main.selection),
            oracle: executionModelRoute("oracle", oracle.selection),
          },
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const join = database
          .query<
            { readonly output_json: string },
            []
          >("select result.output_json from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.name = 'await_subagents'")
          .get()
        return { settled, join }
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
      Effect.tap(({ settled, join }) =>
        Effect.sync(() => {
          expect(settled.status).toBe("completed")
          expect(join?.output_json).toContain('"_tag":"NoReport"')
          expect(join?.output_json).toContain("Run ended without output")
          expect(join?.output_json).toContain("Re-run this delegation once")
        }),
      ),
    ),
  )
}, 60_000)
test("one root batch can start more than four delegations", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-unbounded-" })
      const main = yield* TestModel.make(
        [
          TestModel.turn(
            Array.from({ length: 6 }, (_, index) =>
              TestModel.toolCall("oracle", { prompt: `Explore ${index}.` }, { id: `call-${index}` }),
            ),
          ),
          TestModel.toolCall("await_subagents", {}, { id: "call-join" }),
          TestModel.text("Root collected the bounded batch."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" },
      )
      const child = yield* TestModel.make(
        Array.from({ length: 6 }, (_, index) => TestModel.text(`Child ${index} reported.`)),
        { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-medium" },
      )
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: main.registration,
        additionalRegistrations: [child.registration],
        selection: main.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-budget",
          turnId: "turn-budget",
          prompt: "Explore six things at once.",
          executionRoute: {
            version: 1 as const,
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
          .query<{ readonly id: string }, []>("select id from relay_executions where id like 'child:%'")
          .all()
        const results = database
          .query<
            { readonly error: string | null },
            []
          >("select result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.name = 'oracle' order by call.id")
          .all()
        return { settled, children, results }
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
      Effect.tap(({ settled, children, results }) =>
        Effect.sync(() => {
          expect(settled.status, encodeJson(settled.events.filter((event) => event.type === "execution.failed"))).toBe(
            "completed",
          )
          expect(children).toHaveLength(6)
          expect(results).toHaveLength(6)
          expect(results.every((result) => result.error === null)).toBe(true)
        }),
      ),
    ),
  )
}, 60_000)
test("collecting one batch allows a later delegation", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-budget-reuse-" })
      const main = yield* TestModel.make(
        [
          TestModel.turn(
            Array.from({ length: 4 }, (_, index) =>
              TestModel.toolCall("oracle", { prompt: `Explore ${index}.` }, { id: `call-${index}` }),
            ),
          ),
          TestModel.toolCall("await_subagents", {}, { id: "call-join-first" }),
          TestModel.toolCall("oracle", { prompt: "Explore once more." }, { id: "call-late" }),
          TestModel.toolCall("await_subagents", {}, { id: "call-join-second" }),
          TestModel.text("Root collected both rounds."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" },
      )
      const child = yield* TestModel.make(
        Array.from({ length: 5 }, (_, index) => TestModel.text(`Child ${index} reported.`)),
        { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-medium" },
      )
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: main.registration,
        additionalRegistrations: [child.registration],
        selection: main.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-budget-reuse",
          turnId: "turn-budget-reuse",
          prompt: "Explore four things, collect them, then explore once more.",
          executionRoute: {
            version: 1 as const,
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
          .query<{ readonly id: string }, []>("select id from relay_executions where id like 'child:%'")
          .all()
        const results = database
          .query<
            { readonly id: string; readonly error: string | null },
            []
          >("select call.id, result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.name = 'oracle' order by call.id")
          .all()
        return { settled, children, results }
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
      Effect.tap(({ settled, children, results }) =>
        Effect.sync(() => {
          expect(settled.status, encodeJson(settled.events.filter((event) => event.type === "execution.failed"))).toBe(
            "completed",
          )
          expect(children).toHaveLength(5)
          expect(results).toHaveLength(5)
          expect(results.every((result) => result.error === null)).toBe(true)
        }),
      ),
    ),
  )
}, 60_000)
