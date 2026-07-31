import * as ThreadToolkits from "@rika/coding-tools/thread-tool-contract"
import * as BunServices from "@effect/platform-bun/BunServices"
import { LanguageModel, ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"

import { expect, test } from "vitest"

import { Database } from "bun:sqlite"
import { Clock, Effect, FileSystem, Layer, Ref, Schema, Stream } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"

import { layer } from "../src/relay/execution/relay-execution-layer"
import { routedModel } from "./routed-model"
import { start } from "./current-execution-route"

import { fixture as testSupport } from "./subagent-spawn-fixture"
const { encodeJson, decodeToolExecution, parallelRootPrompt, executionModelRoute } = testSupport
test("three Task calls in one model turn run as overlapping durable children", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-parallel-" })
      const fixture = yield* routedModel({
        lanes: [
          {
            steps: [
              TestModel.turn([
                TestModel.toolCall("task", { prompt: "Explore alpha." }, { id: "call-alpha" }),
                TestModel.toolCall("task", { prompt: "Explore beta." }, { id: "call-beta" }),
                TestModel.toolCall("task", { prompt: "Explore gamma." }, { id: "call-gamma" }),
              ]),
              TestModel.turn([TestModel.toolCall("await_subagents", {}, { id: "call-join" })]),
              TestModel.text("All three explorations finished."),
            ],
          },
          {
            when: (prompt) => !prompt.includes(parallelRootPrompt),
            steps: [
              TestModel.turn([TestModel.text("alpha")], { delay: "400 millis" }),
              TestModel.turn([TestModel.text("beta")], { delay: "400 millis" }),
              TestModel.turn([TestModel.text("gamma")], { delay: "400 millis" }),
            ],
          },
        ],
      })
      const windows = yield* Ref.make<
        Array<{ readonly prompt: string; readonly startedAt: number; readonly completedAt?: number }>
      >([])
      const trackingLayer = Layer.effect(
        LanguageModel.LanguageModel,
        Effect.gen(function* () {
          const model = yield* LanguageModel.LanguageModel
          const streamText = ((options: Parameters<LanguageModel.Service["streamText"]>[0]) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const prompt = encodeJson(options.prompt)
                const startedAt = yield* Clock.currentTimeMillis
                const index = yield* Ref.modify(windows, (current) => [
                  current.length,
                  [...current, { prompt, startedAt }],
                ])
                return model
                  .streamText(options)
                  .pipe(
                    Stream.ensuring(
                      Clock.currentTimeMillis.pipe(
                        Effect.flatMap((completedAt) =>
                          Ref.update(windows, (current) =>
                            current.map((window, currentIndex) =>
                              currentIndex === index ? { ...window, completedAt } : window,
                            ),
                          ),
                        ),
                      ),
                    ),
                  )
              }),
            )) as LanguageModel.Service["streamText"]
          return { ...model, streamText }
        }),
      ).pipe(Layer.provide(fixture.layer))
      const registration = yield* ModelRegistry.registration({
        ...fixture.selection,
        layer: trackingLayer,
      })
      const backendLayer = layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-parallel-spawn",
          turnId: "turn-parallel-spawn",
          prompt: parallelRootPrompt,
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const children = database
          .query<
            { readonly id: string; readonly status: string; readonly agent_snapshot_json: string },
            []
          >("select e.id as id, e.status as status, s.definition_json as agent_snapshot_json from relay_executions e join relay_agent_definition_snapshots s on s.digest = e.agent_definition_digest where e.id like 'child:%' order by e.id")
          .all()
        const root = database
          .query<
            { readonly agent_snapshot_json: string },
            []
          >("select s.definition_json as agent_snapshot_json from relay_executions e join relay_agent_definition_snapshots s on s.digest = e.agent_definition_digest where e.id = 'execution:turn-parallel-spawn'")
          .get()
        const childRuns = database
          .query<
            { readonly id: string; readonly metadata_json: string },
            []
          >("select id, metadata_json from relay_child_executions order by id")
          .all()
        return {
          settled,
          children,
          root,
          childRuns,
          selection: fixture.selection,
          requests: yield* fixture.requests,
          windows: yield* Ref.get(windows),
        }
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
      Effect.tap(({ settled, children, root, childRuns, selection, requests, windows }) =>
        Effect.sync(() => {
          const childWindows = windows.filter((window) => !window.prompt.includes(parallelRootPrompt))
          expect(settled.status, encodeJson(settled.events.filter((event) => event.type === "execution.failed"))).toBe(
            "completed",
          )
          expect(settled.events.filter((event) => event.type === "child_run.spawned")).toHaveLength(3)
          expect(children).toHaveLength(3)
          expect(children.every((child) => child.status === "completed")).toBe(true)
          expect(decodeToolExecution(root?.agent_snapshot_json ?? "{}").tool_execution).toEqual({
            concurrency: "unbounded",
          })
          expect(
            children.every(
              (child) => decodeToolExecution(child.agent_snapshot_json).tool_execution?.concurrency === "unbounded",
            ),
          ).toBe(true)
          expect(childRuns).toHaveLength(3)
          expect(
            children.map(({ agent_snapshot_json }) => {
              const snapshot = JSON.parse(agent_snapshot_json) as {
                readonly model?: { readonly model?: string; readonly registration_key?: string }
              }
              return [snapshot.model?.model, snapshot.model?.registration_key]
            }),
          ).toEqual([
            [selection.model, selection.registrationKey],
            [selection.model, selection.registrationKey],
            [selection.model, selection.registrationKey],
          ])
          expect(windows).toHaveLength(6)
          expect(childWindows).toHaveLength(3)
          expect(
            childWindows.every((window) =>
              ["Explore alpha.", "Explore beta.", "Explore gamma."].some((prompt) => window.prompt.includes(prompt)),
            ),
          ).toBe(true)
          expect(Math.max(...childWindows.map((window) => window.startedAt))).toBeLessThan(
            Math.min(...childWindows.map((window) => window.completedAt ?? 0)),
          )
          expect(requests.every((request) => request.operation === "streamText")).toBe(true)
          expect(
            settled.events
              .filter(
                (event) => event.type === "model.output.delta" && event.executionId === "execution:turn-parallel-spawn",
              )
              .map((event) => event.text)
              .join(""),
          ).toBe("All three explorations finished.")
        }),
      ),
    ),
  )
}, 60_000)
test("ReadThread uses the Oracle route and receives the current Thread identity", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-read-thread-agent-" })
      const main = yield* TestModel.make(
        [
          TestModel.toolCall("read_thread", { prompt: "Recover the earlier requirement." }, { id: "read-thread" }),
          TestModel.text("Recovered the requirement."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-xhigh" },
      )
      const oracle = yield* TestModel.make([TestModel.text("The earlier requirement was exact.")], {
        provider: "test",
        model: "gpt-5.6-sol",
        registrationKey: "sol-medium",
      })
      const backendLayer = layer({
        filename: `${directory}/execution.db`,
        workspace: directory,
        registration: main.registration,
        additionalRegistrations: [oracle.registration],
        selection: main.selection,
        additionalToolkit: ThreadToolkits.ThreadContract.toolkit,
        additionalHandlerLayer: ThreadToolkits.ThreadContract.toolkit.toLayer({
          search_threads: () => Effect.succeed({ text: "", truncated: false }),
          read_thread_transcript: () => Effect.succeed({ text: "", truncated: false }),
        }),
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const route: ExecutionBackend.ExecutionRoutePin = {
          version: 1 as const,
          mode: "medium",
          main: executionModelRoute("main", main.selection, "xhigh"),
          oracle: executionModelRoute("oracle", oracle.selection, "medium"),
        }
        const settled = yield* start(backend, {
          threadId: "thread-current-context",
          turnId: "turn-current-context",
          prompt: "Recover an earlier requirement.",
          executionRoute: route,
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/execution.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const child = database
          .query<
            { readonly agent_snapshot_json: string },
            []
          >("select s.definition_json as agent_snapshot_json from relay_executions e join relay_agent_definition_snapshots s on s.digest = e.agent_definition_digest where e.id like 'child:%'")
          .get()
        return { settled, child, oracleRequests: yield* oracle.requests }
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
      Effect.tap(({ settled, child, oracleRequests }) =>
        Effect.gen(function* () {
          const snapshot = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
            child?.agent_snapshot_json ?? "{}",
          )
          expect(settled.status).toBe("completed")
          expect(oracleRequests).toHaveLength(1)
          expect(encodeJson(oracleRequests[0]?.prompt)).toContain("Current thread ID: thread-current-context")
          expect(encodeJson(oracleRequests[0]?.prompt)).toContain("Recover the earlier requirement.")
          expect(oracleRequests[0]?.tools.map((tool) => tool.name)).toEqual([
            "search_threads",
            "read_thread_transcript",
          ])
          expect(snapshot).toMatchObject({
            model: {
              model: "gpt-5.6-sol",
              registration_key: "sol-medium",
              metadata: {
                rika_thread_id: "thread-current-context",
                rika_reasoning_effort: "medium",
              },
            },
          })
        }),
      ),
    ),
  )
}, 60_000)
