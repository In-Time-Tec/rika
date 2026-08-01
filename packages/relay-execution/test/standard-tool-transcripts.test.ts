import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"
import { layer } from "../src/relay/execution/relay-execution-layer"
import { start } from "./current-execution-route"

const cases = [
  ["grep", { pattern: "needle", regex: false }, "pattern"],
  ["read", { path: "fixture.txt", read_range: [1, 1] }, "path"],
  ["write", { path: "created.txt", content: "value" }, "path"],
  ["edit", { path: "fixture.txt", old_str: "old", new_str: "new" }, "path"],
  ["bash", { command: "printf safe" }, "command"],
  ["shell_command_status", { processId: "process-1", waitMillis: 0 }, "processId"],
  ["web_search", { objective: "deterministic research", searchQueries: ["fixture"] }, "objective"],
  ["read_web_page", { url: "https://example.test/page", fullContent: true }, "url"],
  ["view_media", { path: "fixture.png" }, "path"],
] as const

const caseNames = new Set<string>(cases.map(([name]) => name))
const standardNames = Catalog.definitions
  .map(({ name }) => name)
  .filter((name): name is (typeof cases)[number][0] => caseNames.has(name))

test("standard catalog transcript matrix is complete", () => {
  expect(cases.map(([name]) => name).toSorted()).toEqual(standardNames.toSorted())
})

for (const [name, parameters, malformedField] of cases) {
  test(`persists deterministic ${name} call and result`, () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-tool-matrix-" })
        const fixture = yield* TestModel.make([
          TestModel.toolCall(name, parameters, { id: `call-${name}` }),
          TestModel.text(`${name} complete`),
        ])
        const definition = Catalog.get(name)!
        const marker = name === "read" ? "[REDACTED]" : `deterministic ${name}`
        const bounded = marker
          .repeat(Math.ceil((definition.outputLimit + 1) / marker.length))
          .slice(0, definition.outputLimit)
        const runtimeLayer = Runtime.testLayer((request) =>
          request._tag === "Read"
            ? Effect.succeed({ text: "[REDACTED]", truncated: false })
            : Effect.succeed({ text: bounded, truncated: true }),
        )
        const backendLayer = layer({
          filename: `${directory}/execution.db`,
          workspace: directory,
          registration: fixture.registration,
          selection: fixture.selection,
          modelVariantPolicy: "fixed-selection",
          webSearchCredentials: { parallel: Redacted.make("web-test-key") },
          toolRuntimeLayer: runtimeLayer,
        })
        const backendContext = yield* Layer.build(backendLayer)
        return yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          const completed = yield* start(backend, {
            threadId: `thread-${name}`,
            turnId: `turn-${name}`,
            prompt: `invoke ${name}`,
          })
          return { completed, replay: yield* backend.replay(`turn-${name}`), requests: yield* fixture.requests }
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
        Effect.tap((result) =>
          Effect.gen(function* () {
            const transcript = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(result.requests[1])
            yield* Effect.sync(() => {
              const types = result.replay.events.map((event) => event.type)
              expect(result.completed.status).toBe("completed")
              expect(types).toContain("tool.call.requested")
              expect(types).toContain("tool.result.received")
              expect(result.replay.events).toEqual(
                result.completed.events.filter((event) => event.data?.transient_index === undefined),
              )
              expect(transcript).not.toContain("rika-tool-matrix-")
              if (name !== "read") expect(transcript).toContain('"truncated":true')
              if (name === "read") expect(transcript).toContain("[REDACTED]")
            })
          }),
        ),
      ),
    )
  }, 30_000)

  test(
    `returns canonical failure for malformed ${name} input at the durable boundary`,
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const bunContext = yield* Layer.build(BunServices.layer)
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const fileSystem = yield* FileSystem.FileSystem
                const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-malformed-" })
                const malformedInput = { malformed: 42 }
                const fixture = yield* TestModel.make(
                  Array.from({ length: 3 }, (_, index) =>
                    TestModel.toolCall(name, malformedInput, { id: `bad-${name}-${index + 1}` }),
                  ),
                )
                const backendContext = yield* Layer.build(
                  layer({
                    filename: `${directory}/execution.db`,
                    workspace: directory,
                    registration: fixture.registration,
                    selection: fixture.selection,
                    modelVariantPolicy: "fixed-selection",
                    webSearchCredentials: { parallel: Redacted.make("web-test-key") },
                    toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "unexpected", truncated: false })),
                  }),
                )
                return yield* Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  const execution = yield* start(backend, {
                    threadId: `bad-${name}`,
                    turnId: `bad-${name}`,
                    prompt: "bad",
                  })
                  return { execution, requests: yield* fixture.requests }
                }).pipe(Effect.provide(backendContext))
              }),
            ).pipe(
              Effect.provide(bunContext),
              Effect.tap((result) =>
                Effect.sync(() => {
                  const failures = result.execution.events.filter((event) => event.type === "execution.failed")
                  const failed = failures[0]
                  expect(result.execution.status).toBe("failed")
                  expect(failures).toHaveLength(1)
                  expect(failed?.text).toMatch(
                    /^effect\/ai\/AiError\/AiError: LanguageModel\.streamText: Invalid output:/,
                  )
                  expect(failed?.text).toContain(name)
                  expect(failed?.text).toContain(malformedField)
                  expect(failed?.data?.message).toBe(failed?.text)
                  expect(failed?.content).toBeUndefined()
                  expect(result.requests).toHaveLength(1)
                }),
              ),
            )
          }),
        ),
      ),
    30_000,
  )
}
