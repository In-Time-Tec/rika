import { BunCrypto } from "@effect/platform-bun"
import * as BunServices from "@effect/platform-bun/BunServices"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { Agent, Approvals, Permissions, ToolContext } from "generalist"
import { activate, layer as durabilityLayer } from "generalist/durability"
import { Host } from "generalist/host"
import { ExecutableResolver, LocalScheduler, RunStore } from "generalist/runtime"
import { TestModel } from "generalist/testing"
import * as DurabilityTesting from "generalist/testing/durability"
import { expect } from "vitest"
import { WorkspaceBinding, WorkspaceComponentState, workspaceComponentLayer } from "@rika/execution"
import { toolkit, tools } from "@rika/execution/tools"
import { scriptedSearchProvider } from "../src/search"
import { layer as runnerLayer } from "../src/workspace"

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "model-runner-workspace",
  assignmentId: "model-runner-assignment",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "model-runner-workspace", checkoutFingerprint: "model-runner-checkout" },
  buildId: "model-runner-build",
  protocolVersion: 1,
})

const agent = Agent.make({
  name: "model-runner-agent",
  input: Schema.String,
  output: Schema.String,
  instructions: "Run the five tools in the selected checkout.",
  toolkit,
  toolExecution: "background",
})

const calls = [
  { tool: "bash", input: { command: "printf runner-bash" } },
  { tool: "read", input: { path: "fixture.txt" } },
  { tool: "edit", input: { path: "editable.txt", old_str: "before", new_str: "after" } },
  { tool: "grep", input: { pattern: "before", glob: "fixture.txt" } },
  { tool: "web_search", input: { query: "Effect" } },
] as const

const followups = Array.from({ length: 13 }, (_batch, batch) => [
  TestModel.turn(
    Array.from({ length: 10 }, (_, index) =>
      TestModel.toolCall("read", { path: "fixture.txt" }, { id: `read-${batch}-${index}` }),
    ),
  ),
  TestModel.turn([TestModel.text("done")]),
]).flat()

it.live(
  "runs Bash, Read, Edit, Grep, and Web Search as parent-admitted Runner Tool Runs",
  () =>
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const runtime = durabilityLayer({
        environment: "model-runner-test",
        tenant: "owner",
        partition: "thread-model-runner",
        maxStateBytes: 128 * 1024 * 1024,
        addresses: [],
        scheduler: { concurrency: 16 },
      }).pipe(
        Layer.provide(ExecutableResolver.layerStatic([])),
        Layer.provide(DurabilityTesting.layer(bucket)),
        Layer.provide(BunCrypto.layer),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "rika-model-runner-" })
          yield* fs.writeFileString(`${checkout}/fixture.txt`, "before\n")
          yield* fs.writeFileString(`${checkout}/editable.txt`, "before\n")
          const host = yield* Host.make({ agents: { [agent.name]: agent }, revision: "model-runner-test", tools }).pipe(
            Effect.provide(
              yield* Layer.build(
                Layer.mergeAll(
                  TestModel.layer([
                    TestModel.turn(
                      calls.map((call) => TestModel.toolCall(call.tool, call.input, { id: `call-${call.tool}` })),
                    ),
                    TestModel.turn([TestModel.text("done")]),
                    ...followups,
                  ]),
                  Permissions.layerAllowAll,
                  Approvals.layerAutoApprove,
                  workspaceComponentLayer,
                  runnerLayer({
                    checkout,
                    binding,
                    searchProvider: scriptedSearchProvider({
                      results: new Map([
                        [
                          "Effect",
                          [
                            {
                              title: "Effect",
                              url: "https://effect.website",
                              snippet: "Typed functional effect system",
                            },
                          ],
                        ],
                      ]),
                    }),
                  }),
                  toolkit.toLayer({
                    bash: () => Effect.die("Bash bypassed the ToolExecutor"),
                    read: () => Effect.die("Read bypassed the ToolExecutor"),
                    edit: () => Effect.die("Edit bypassed the ToolExecutor"),
                    grep: () => Effect.die("Grep bypassed the ToolExecutor"),
                    web_search: () => Effect.die("Web Search bypassed the ToolExecutor"),
                  }),
                ).pipe(Layer.provide(ToolContext.layerDefault)),
              ),
            ),
          )
          yield* activate
          const session = yield* host.sessions.create({ id: "session:model-runner", agent: agent.name })
          const parent = yield* host.runs.start(session.id, agent, "run five tools")
          const scheduler = yield* LocalScheduler.LocalScheduler
          yield* scheduler.drain({ fuel: 64 })
          yield* scheduler.drain({ fuel: 64 })
          expect(yield* parent.await).toBe("done")
          const children = yield* host.runs.children(parent.id)
          expect(children).toHaveLength(5)
          const store = yield* RunStore.RunStore
          const results = new Map<string, unknown>()
          for (const child of children) {
            const execution = yield* store.loadExecution(child.childRunId)
            expect(execution.parentRunId).toBe(parent.id)
            const parentOperation = yield* store.getOperationByKey({
              runId: parent.id,
              operationKey: execution.message.idempotencyKey,
            })
            const input = yield* Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String }))(
              parentOperation?.input,
            )
            expect(parentOperation?.kind).toBe("tool")
            const handle = yield* host.tools.getByName(input.name, child.childRunId)
            results.set(input.name, yield* handle.await.pipe(Effect.timeout("10 seconds")))
            expect((yield* host.runs.inspectChild(parent.id, child.childRunId)).status).toBe("succeeded")
          }
          expect(results.get("bash")).toMatchObject({ text: "runner-bash", exitCode: 0 })
          expect(results.get("read")).toMatchObject({ text: "1: before\n2: " })
          const edited = yield* Schema.decodeUnknownEffect(Schema.Struct({ diff: Schema.String }))(results.get("edit"))
          expect(edited.diff).toContain("+after")
          expect(results.get("grep")).toMatchObject({ text: "fixture.txt:1:before" })
          expect(results.get("web_search")).toMatchObject({
            query: "Effect",
            provider: "scripted",
            sourceUrls: ["https://effect.website"],
          })
          expect(yield* fs.readFileString(`${checkout}/editable.txt`)).toBe("after\n")
          const parentExecution = yield* store.loadExecution(parent.id)
          const component = parentExecution.sessionComponents?.find(
            (entry) => entry.descriptor.key === "rika-workspace-binding",
          )
          const state = yield* Schema.decodeUnknownEffect(WorkspaceComponentState)(component?.state)
          expect(state.binding).toEqual(binding)
          expect(state.admitted).toEqual([])
          expect(component?.receipts).toHaveLength(1)
          for (const options of [undefined, { parentRunId: parent.id, commandId: "forged-native-admission" }]) {
            const forbidden = yield* host.tools.startByName("bash", { command: "touch forbidden.txt" }, options)
            yield* scheduler.drain({ fuel: 64 })
            expect((yield* Effect.result(forbidden.await.pipe(Effect.timeout("10 seconds"))))._tag).toBe("Failure")
            expect(yield* fs.exists(`${checkout}/forbidden.txt`)).toBe(false)
          }
          let completed = 5
          for (let batch = 0; batch < 13; batch += 1) {
            const next = yield* host.runs.start(session.id, agent, `read batch ${batch}`)
            yield* scheduler.drain({ fuel: 64 })
            expect(yield* next.await.pipe(Effect.timeout("10 seconds"))).toBe("done")
            const reads = yield* host.runs.children(next.id)
            expect(reads).toHaveLength(10)
            for (const child of reads) {
              const handle = yield* host.tools.getByName("read", child.childRunId)
              expect(yield* handle.await.pipe(Effect.timeout("10 seconds"))).toMatchObject({ text: "1: before\n2: " })
              completed += 1
            }
            const execution = yield* store.loadExecution(next.id)
            const checkpoint = execution.sessionComponents?.find(
              (entry) => entry.descriptor.key === "rika-workspace-binding",
            )
            const current = yield* Schema.decodeUnknownEffect(WorkspaceComponentState)(checkpoint?.state)
            expect(current.binding).toEqual(binding)
            expect(current.admitted).toEqual([])
            expect(checkpoint?.receipts).toHaveLength(1)
          }
          expect(completed).toBe(135)
        }).pipe(Effect.provide(yield* Layer.build(Layer.merge(runtime, BunServices.layer)))),
      )
    }),
  180_000,
)
