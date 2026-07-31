import * as BunServices from "@effect/platform-bun/BunServices"
import { LanguageModel, ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Deferred, Effect, Fiber, FileSystem, Layer, Schedule, Stream } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"

import * as RelayExecutionBackend from "../src/relay/execution/relay-execution-layer"

import { start } from "./current-execution-route"

import { fixture as testSupport } from "./subagent-join-fixture"
const { encodeJson, executionModelRoute } = testSupport
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
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const running = yield* start(backend, {
          threadId: "thread-join-suspend",
          turnId: "turn-join-suspend",
          prompt: "Ask the Oracle to investigate slowly.",
          executionRoute: {
            version: 1 as const,
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
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-join-abandon",
          turnId: "turn-join-abandon",
          prompt: "Ask the Oracle to investigate forever.",
          executionRoute: {
            version: 1 as const,
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
