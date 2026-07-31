import * as BunServices from "@effect/platform-bun/BunServices"
import { LanguageModel, ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Deferred, Effect, FileSystem, Layer, Ref, Stream } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"

import * as RelayExecutionBackend from "../src/relay/execution/relay-execution-layer"

import { start } from "./current-execution-route"

import { fixture as testSupport } from "./subagent-join-fixture"
const { encodeJson, executionModelRoute } = testSupport
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
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-join-parallel",
          turnId: "turn-join-parallel",
          prompt: "Explore alpha and beta.",
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
