import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { Catalog, Runtime, ThreadTools } from "@rika/tools"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

const cases = [
  ["find_files", { query: "fixture" }, "query"],
  ["grep", { pattern: "needle", regex: false }, "pattern"],
  ["read_file", { path: "fixture.txt", limit: 1 }, "path"],
  ["create_file", { path: "created.txt", content: "value" }, "path"],
  ["edit_file", { path: "fixture.txt", oldText: "old", newText: "new" }, "path"],
  ["apply_patch", { patchText: "*** Begin Patch\n*** End Patch" }, "patchText"],
  ["shell", { command: "printf", args: ["safe"] }, "command"],
  ["shell_command_status", { processId: "process-1", waitMillis: 0 }, "processId"],
  ["git_status", {}, "refresh"],
  ["web_search", { objective: "deterministic research", searchQueries: ["fixture"] }, "objective"],
  ["read_web_page", { url: "https://example.test/page", fullContent: true }, "url"],
  ["view_media", { path: "fixture.png" }, "path"],
  ["find_thread", { query: "workspace:fixture", limit: 1 }, "query"],
  ["read_thread", { threadId: "thread-fixture", maxTurns: 1, maxChars: 100 }, "threadId"],
] as const

const caseNames = new Set<string>(cases.map(([name]) => name))
const standardNames = Catalog.definitions
  .map(({ name }) => name)
  .filter((name): name is (typeof cases)[number][0] => caseNames.has(name))

const threadHandlers = ThreadTools.toolkit.toLayer(
  Effect.succeed({
    find_thread: () => Effect.succeed({ text: "thread result", truncated: false }),
    read_thread: () => Effect.succeed({ text: "thread transcript", truncated: false }),
  }),
)

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
        const marker = name === "read_file" ? "[REDACTED]" : `deterministic ${name}`
        const bounded = marker
          .repeat(Math.ceil((definition.outputLimit + 1) / marker.length))
          .slice(0, definition.outputLimit)
        const runtimeLayer = Runtime.testLayer((request) =>
          request._tag === "ReadFile"
            ? Effect.succeed({ text: "[REDACTED]", truncated: false })
            : Effect.succeed({ text: bounded, truncated: true }),
        )
        const backendLayer = RelayExecutionBackend.layer({
          filename: `${directory}/relay.db`,
          workspace: directory,
          registration: fixture.registration,
          selection: fixture.selection,
          modelVariantPolicy: "fixed-selection",
          additionalToolkit: ThreadTools.toolkit,
          additionalHandlerLayer: threadHandlers,
          toolRuntimeLayer: runtimeLayer,
          toolNeedsApproval: () => false,
          permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
        })
        const backendContext = yield* Layer.build(backendLayer)
        return yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          const completed = yield* start(backend, {
            threadId: `thread-${name}`,
            turnId: `turn-${name}`,
            prompt: `invoke ${name}`,
            startedAt: 1,
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
              const definition = Catalog.get(name)!
              const types = result.replay.events.map((event) => event.type)
              expect(result.completed.status).toBe("completed")
              expect(types).toContain("tool.call.requested")
              expect(types).toContain("tool.result.received")
              expect(result.replay.events).toEqual(result.completed.events)
              expect(definition.permission).toBe("allow")
              expect(transcript).not.toContain("rika-tool-matrix-")
              if (name !== "read_file" && name !== "find_thread" && name !== "read_thread")
                expect(transcript).toContain('"truncated":true')
              if (name === "read_file") expect(transcript).toContain("[REDACTED]")
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
                const malformedInput = name === "git_status" ? { refresh: 42 } : { malformed: 42 }
                const fixture = yield* TestModel.make(
                  Array.from({ length: 3 }, (_, index) =>
                    TestModel.toolCall(name, malformedInput, { id: `bad-${name}-${index + 1}` }),
                  ),
                )
                const backendContext = yield* Layer.build(
                  RelayExecutionBackend.layer({
                    filename: `${directory}/relay.db`,
                    workspace: directory,
                    registration: fixture.registration,
                    selection: fixture.selection,
                    modelVariantPolicy: "fixed-selection",
                    additionalToolkit: ThreadTools.toolkit,
                    additionalHandlerLayer: threadHandlers,
                    toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "unexpected", truncated: false })),
                    toolNeedsApproval: () => false,
                    permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
                  }),
                )
                return yield* Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  const execution = yield* start(backend, {
                    threadId: `bad-${name}`,
                    turnId: `bad-${name}`,
                    prompt: "bad",
                    startedAt: 1,
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
                  expect(result.requests).toHaveLength(3)
                }),
              ),
            )
          }),
        ),
      ),
    30_000,
  )
}
