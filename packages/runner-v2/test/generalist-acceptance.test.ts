/* oxlint-disable max-lines, effecttsgo/strict-effect-provide -- this fixture proves parent-owned Runner Tool Runs through Generalist. */
import { BunCrypto } from "@effect/platform-bun"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Deferred, Effect, FileSystem, Fiber, Layer, Queue, Ref, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { it } from "@effect/vitest"
import { Agent, Approvals, Permissions, ToolContext, ToolExecutor } from "generalist"
import { activate, layer as durabilityLayer } from "generalist/durability"
import { Host, ToolIdentity } from "generalist/host"
import { ExecutableResolver, LocalScheduler, RunStore } from "generalist/runtime"
import { TestModel } from "generalist/testing"
import * as DurabilityTesting from "generalist/testing/durability"
import { expect } from "vitest"

import {
  WorkspaceBinding,
  WorkspaceComponentState,
  workspaceComponentLayer,
  workspaceComponentJournal,
} from "@rika/execution-v2"
import { scriptedSearchProvider, type SearchItem } from "../src/search"
import { inputDigest, layerWithRoutes as runnerLayer, makeNativeOperationIntent } from "../src/workspace"
import { bash, edit, grep, read, webSearch } from "../src/tools"

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "runner-generalist-workspace",
  assignmentId: "runner-generalist-assignment",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "runner-generalist-workspace", checkoutFingerprint: "runner-generalist-checkout" },
  buildId: "runner-generalist-build",
  protocolVersion: 1,
})

const failure = Schema.Struct({ kind: Schema.String, message: Schema.String })
const admissionReceipt = Schema.Struct({
  _tag: Schema.Literal("ToolRunAdmitted"),
  runId: Schema.String,
  tool: Schema.String,
  operationId: Schema.String,
})
const admitTool = Tool.make("admit_runner", {
  description: "Admit the five Runner Tool Runs from the parent Agent.",
  parameters: Schema.Struct({}),
  success: Schema.Array(admissionReceipt),
  failure,
  failureMode: "return",
})
  .annotate(ToolIdentity, { implementation: "runner-generalist-admit", policy: "runner-generalist" })
  .addDependency(ToolContext.ToolContext)
  .addDependency(RunStore.RunStore)

const runnerBash = bash.setNeedsApproval(true)
const runnerRead = read.setNeedsApproval(true)
const runnerEdit = edit.setNeedsApproval(true)
const runnerGrep = grep.setNeedsApproval(true)
const runnerWebSearch = webSearch.setNeedsApproval(true)
const runnerTools = [runnerBash, runnerRead, runnerEdit, runnerGrep, runnerWebSearch] as const
const runnerToolkit = Toolkit.make(...runnerTools)
const toolkit = Toolkit.make(admitTool)

const agent = Agent.make({
  name: "runner-generalist-agent",
  input: Schema.String,
  output: Schema.String,
  instructions: "Start the Runner tools and finish.",
  toolkit,
  toolExecution: "inline",
})

const childCalls = [
  { tool: "bash", input: { command: "printf runner-bash" } },
  { tool: "read", input: { path: "fixture.txt" } },
  { tool: "edit", input: { path: "fixture.txt", old_str: "before", new_str: "after" } },
  { tool: "grep", input: { pattern: "after", glob: "*.txt" } },
  { tool: "web_search", input: { query: "Effect" } },
] as const

const searchItems: ReadonlyArray<SearchItem> = [{
  title: "Effect",
  url: "https://effect.website",
  snippet: "Typed functional effect system",
}]

const testRuntime = (bucket: DurabilityTesting.Simulator) =>
  durabilityLayer({
    environment: "runner-generalist-test",
    tenant: "owner",
    partition: "thread-runner-generalist",
    addresses: [],
    scheduler: { concurrency: 16 },
  }).pipe(
    Layer.provide(ExecutableResolver.layerStatic([])),
    Layer.provide(DurabilityTesting.layer(bucket)),
    Layer.provide(BunCrypto.layer),
  )

const drain = Effect.gen(function* () {
  const scheduler = yield* LocalScheduler.LocalScheduler
  yield* scheduler.drain({ fuel: 64 })
  yield* scheduler.drain({ fuel: 64 })
  yield* scheduler.drain({ fuel: 64 })
  yield* scheduler.drain({ fuel: 64 })
})

interface StartedTool {
  readonly id: string
  readonly tool: string
  readonly input: Schema.Json
}

const hostLayer = (
  checkout: string,
  children: Ref.Ref<ReadonlyArray<StartedTool>>,
  approvals: Queue.Queue<{ readonly pending: Approvals.Pending; readonly release: Deferred.Deferred<void> }>,
  admitted: Ref.Ref<ReadonlyArray<typeof admissionReceipt.Type>>,
) =>
  Layer.mergeAll(
    TestModel.layer([
      TestModel.turn([TestModel.toolCall("admit_runner", {}, { id: "admit-runner" })]),
      TestModel.turn([TestModel.text("done")]),
    ]),
    Permissions.layerAllowAll,
    workspaceComponentLayer,
    runnerLayer(
      {
        checkout,
        binding,
        searchProvider: scriptedSearchProvider({ results: new Map([["Effect", searchItems]]) }),
      },
      [
        ToolExecutor.route({
          tools: ["admit_runner"],
          replayPolicy: () => "never",
          execute: () =>
            Effect.gen(function* () {
              const context = yield* ToolContext.ToolContext
              const parentRunId = context.runId
              const operationKey = context.operationKey
              if (parentRunId === undefined || operationKey === undefined)
                return yield* Effect.die("Generalist parent admission context is incomplete")
              yield* workspaceComponentJournal.bind(binding, `${operationKey}:bind`)
              const runStore = yield* RunStore.RunStore
              const childRuns = yield* Ref.get(children)
              if (childRuns.length !== childCalls.length) return yield* Effect.die("Runner child admissions are incomplete")
              const receipts: Array<typeof admissionReceipt.Type> = []
              for (const child of childRuns) {
                let operation: { readonly operationKey: string; readonly inputDigest: string; readonly kind: string } | undefined
                for (let attempt = 0; attempt < 128 && operation === undefined; attempt += 1) {
                  const journal = yield* runStore.recoveryJournal(child.id)
                  const operations = yield* Effect.forEach(journal.operations, (entry) =>
                    runStore.getOperation({ runId: child.id, operationId: entry.operationId }),
                  )
                  operation = operations.find((entry) => entry.kind === "tool")
                  if (operation === undefined) yield* Effect.yieldNow
                }
                if (operation === undefined) return yield* Effect.die(`Generalist child ${child.id} has no Tool operation`)
                if (operation.inputDigest !== inputDigest(child.input))
                  return yield* Effect.die(`Generalist child ${child.id} input digest diverges from its Tool operation`)
                const intent = makeNativeOperationIntent({
                  binding,
                  operationId: operation.operationKey,
                  tool: child.tool,
                  input: child.input,
                })
                yield* workspaceComponentJournal.admit(intent, `${operationKey}:admit:${child.tool}`)
                receipts.push({ _tag: "ToolRunAdmitted", runId: child.id, tool: child.tool, operationId: operation.operationKey })
              }
              yield* Ref.set(admitted, receipts)
              return { _tag: "Success" as const, result: receipts, encodedResult: receipts }
            }).pipe(Effect.orDie),
        }),
      ],
    ).pipe(Layer.provide(ToolContext.layerDefault)),
    Approvals.layerTest({
      resolve: (pending) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>()
          yield* Queue.offer(approvals, { pending, release })
          yield* Deferred.await(release)
          return Approvals.Approved()
        }),
    }),
    Toolkit.make(admitTool).toLayer({ admit_runner: () => Effect.die("admit_runner must execute through ToolExecutor") }),
    runnerToolkit
      .toLayer({
        bash: () => Effect.die("Runner Bash must execute through ToolExecutor"),
        read: () => Effect.die("Runner Read must execute through ToolExecutor"),
        edit: () => Effect.die("Runner Edit must execute through ToolExecutor"),
        grep: () => Effect.die("Runner Grep must execute through ToolExecutor"),
        web_search: () => Effect.die("Runner Web Search must execute through ToolExecutor"),
      })
      .pipe(Layer.provide(ToolContext.layerDefault)),
  ).pipe(Layer.provide(ToolContext.layerDefault))

it.effect(
  "runs Bash, Read, Edit, Grep, and Web Search as parent-admitted Runner Tool Runs",
  () =>
    Effect.gen(function* () {
      const bucket = yield* DurabilityTesting.make()
      const approvals = yield* Queue.unbounded<{
        readonly pending: Approvals.Pending
        readonly release: Deferred.Deferred<void>
      }>()
      const children = yield* Ref.make<ReadonlyArray<StartedTool>>([])
      const admitted = yield* Ref.make<ReadonlyArray<typeof admissionReceipt.Type>>([])
      const runtime = Layer.merge(testRuntime(bucket), BunServices.layer)
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-generalist-" })
          yield* fileSystem.writeFileString(`${checkout}/fixture.txt`, "before\n")
          const host = yield* Host.make({
            agents: { [agent.name]: agent },
            revision: "runner-generalist-test",
            tools: [admitTool, ...runnerTools],
          }).pipe(Effect.provide(hostLayer(checkout, children, approvals, admitted)))
          yield* activate
          const session = yield* host.sessions.create({ id: "session:runner-generalist", agent: agent.name })
          const parent = yield* host.runs.start(session.id, agent, "run five tools")
          const started = yield* Effect.forEach(childCalls, (call) =>
            host.tools.startByName(call.tool, call.input, {
              parentRunId: parent.id,
              commandId: `runner-child:${call.tool}`,
            }).pipe(Effect.map((handle) => ({ id: handle.id, tool: call.tool, input: call.input }))),
          )
          yield* Ref.set(children, started)
          const drainFiber = yield* Effect.forkChild(drain)
          for (let index = 0; index < 100; index += 1) yield* Effect.yieldNow
          const queued = yield* Queue.size(approvals)
          const runStore = yield* RunStore.RunStore
          expect(queued).toBe(5)
          const pending: Array<{ readonly pending: Approvals.Pending; readonly release: Deferred.Deferred<void> }> = []
          for (let index = 0; index < queued; index += 1) pending.push(yield* Queue.take(approvals))
          for (const entry of pending) yield* Deferred.succeed(entry.release, undefined)
          yield* Fiber.join(drainFiber)
          expect(yield* parent.await).toBe("done")
          const childAdmissions = yield* Ref.get(admitted)
          expect(childAdmissions).toHaveLength(5)
          const bashAdmission = childAdmissions.find((candidate) => candidate.tool === "bash")
          const readAdmission = childAdmissions.find((candidate) => candidate.tool === "read")
          const editAdmission = childAdmissions.find((candidate) => candidate.tool === "edit")
          const grepAdmission = childAdmissions.find((candidate) => candidate.tool === "grep")
          const searchAdmission = childAdmissions.find((candidate) => candidate.tool === "web_search")
          if (bashAdmission === undefined || readAdmission === undefined || editAdmission === undefined || grepAdmission === undefined || searchAdmission === undefined)
            return yield* Effect.die("Generalist parent admission omitted a Runner Tool")
          const bashResult = yield* host.tools.get(runnerBash, bashAdmission.runId).pipe(Effect.flatMap((handle) => handle.await))
          const readResult = yield* host.tools.get(runnerRead, readAdmission.runId).pipe(Effect.flatMap((handle) => handle.await))
          const editResult = yield* host.tools.get(runnerEdit, editAdmission.runId).pipe(Effect.flatMap((handle) => handle.await))
          const grepResult = yield* host.tools.get(runnerGrep, grepAdmission.runId).pipe(Effect.flatMap((handle) => handle.await))
          const searchResult = yield* host.tools.get(runnerWebSearch, searchAdmission.runId).pipe(Effect.flatMap((handle) => handle.await))
          expect(bashResult).toMatchObject({ text: "runner-bash", stdout: "runner-bash", exitCode: 0 })
          expect(readResult).toMatchObject({ text: "before\n" })
          expect(editResult).toMatchObject({ diff: expect.any(String) })
          expect(grepResult).toMatchObject({ text: "fixture.txt:1:after" })
          expect(searchResult).toMatchObject({
            query: "Effect",
            provider: "scripted",
            sourceUrls: ["https://effect.website"],
          })
          expect(yield* fileSystem.readFileString(`${checkout}/fixture.txt`)).toBe("after\n")
          const parentExecution = yield* runStore.loadExecution(parent.id)
          const checkpoint = parentExecution.sessionComponents?.find(
            (entry) => entry.descriptor.key === "rika-workspace-binding" && entry.descriptor.instance === "v2",
          )
          expect(checkpoint).toBeDefined()
          expect(Schema.decodeUnknownSync(WorkspaceComponentState)(checkpoint?.state)).toMatchObject({ binding })
          for (const entry of childAdmissions) {
            const journal = yield* runStore.recoveryJournal(entry.runId)
            const operations = yield* Effect.forEach(journal.operations, (candidate) =>
              runStore.getOperation({ runId: entry.runId, operationId: candidate.operationId }),
            )
            const operation = operations.find((candidate) => candidate.kind === "tool")
            if (operation === undefined) return yield* Effect.die(`missing ${entry.tool} Tool operation`)
            expect(operation.operationKey).toBe(entry.operationId)
            expect(operation.inputDigest).toBe(inputDigest(childCalls.find((call) => call.tool === entry.tool)!.input))
          }
          return { parentId: parent.id, childAdmissions }
        }).pipe(Effect.provide(runtime)),
      )
      expect(result.childAdmissions).toHaveLength(5)
    }),
  60_000,
)
