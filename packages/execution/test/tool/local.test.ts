import { expect, it } from "@effect/vitest"
import * as ToolRuntime from "@rika/product/native-tool-runtime"
import * as ToolResult from "@rika/product/native-tool-result"
import { Context, Effect, Layer, Schema } from "effect"
import { ToolContext, ToolExecutor } from "generalist"
import { Response } from "effect/unstable/ai"
import { handlerLayer, layer as localLayer } from "../../src/tool/local"
import { toolkit } from "../../src/tool/registry"
import { makeEnvironment, workspace } from "./support"

type NativeToolParams =
  | { readonly path: string; readonly read_range?: readonly [number, number] }
  | { readonly path: string; readonly old_str: string; readonly new_str: string; readonly replace_all?: boolean }
  | { readonly command: string; readonly workdir?: string; readonly timeout_ms?: number }
  | { readonly processId: string; readonly waitMillis?: number | null }

const request = (name: string, params: NativeToolParams): ToolExecutor.Request => {
  const call = Schema.decodeSync(Response.ToolCallPart(name, Schema.Unknown))({
    type: "tool-call",
    id: `call-${name}`,
    name,
    params,
    providerExecuted: false,
  })
  return {
    call,
    toolCallBatch: { calls: [call] },
    turn: 0,
    toolCallIndex: 0,
    agentName: "rika-root",
    sessionId: "thread-one",
  }
}

const toolContext = ToolContext.layerTest({
  signal: new AbortController().signal,
  emit: () => Effect.succeed(true),
  sessionId: "thread-one",
})

it.effect("translates exactly four native handlers and encodes their results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen: Array<ToolRuntime.Request> = []
      const runtime = ToolRuntime.testLayer((input) => {
        seen.push(input)
        return Effect.succeed({ text: input._tag, truncated: false })
      })
      const executorLayer = ToolExecutor.layerToolkit(toolkit).pipe(Layer.provide(handlerLayer), Layer.provide(runtime))
      const context = yield* Layer.build(Layer.merge(executorLayer, toolContext))
      const executor = Context.get(context, ToolExecutor.ToolExecutor)
      const calls = [
        request("read", { path: "a.ts", read_range: [2, 4] }),
        request("edit", { path: "a.ts", old_str: "old", new_str: "new", replace_all: true }),
        request("bash", { command: "printf ok", workdir: "sub", timeout_ms: 0 }),
        request("shell_command_status", { processId: "process-one", waitMillis: 100 }),
      ]
      const outcomes = yield* Effect.provide(Effect.forEach(calls, executor.execute), context)

      expect(seen).toEqual([
        { _tag: "Read", path: "a.ts", readRange: [2, 4] },
        { _tag: "Edit", path: "a.ts", oldStr: "old", newStr: "new", replaceAll: true },
        { _tag: "Bash", command: "printf ok", workdir: "sub", timeoutMillis: 0 },
        { _tag: "ShellCommandStatus", processId: "process-one", waitMillis: 100 },
      ])
      expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Success", "Success", "Success", "Success"])
      expect(outcomes.map((outcome) => (outcome._tag === "Success" ? outcome.encodedResult : undefined))).toEqual([
        { text: "Read", truncated: false },
        { text: "Edit", truncated: false },
        { text: "Bash", truncated: false },
        { text: "ShellCommandStatus", truncated: false },
      ])
    }),
  ),
)

it.effect("keeps one process registry across ToolExecutor and recorded-shell runtime for one Run layer", () => {
  const environment = makeEnvironment()
  return Effect.gen(function* () {
    const started = yield* Effect.scoped(
      Effect.gen(function* () {
        const runLayer = localLayer(workspace).pipe(Layer.provide(environment.dependencies))
        const context = yield* Layer.build(Layer.merge(runLayer, toolContext))
        const executor = Context.get(context, ToolExecutor.ToolExecutor)
        const runtime = Context.get(context, ToolRuntime.Service)
        const outcome = yield* executor
          .execute(request("bash", { command: "running", timeout_ms: 0 }))
          .pipe(Effect.provide(context))
        expect(outcome._tag).toBe("Success")
        if (outcome._tag !== "Success") return yield* Effect.die("expected successful background bash")
        const result = yield* Schema.decodeUnknownEffect(ToolResult.Result)(outcome.encodedResult)
        const status = yield* runtime.run({
          _tag: "ShellCommandStatus",
          processId: result.processId ?? "",
          waitMillis: 0,
        })
        expect(status.processId).toBe(result.processId)
        expect(status.running).toBe(true)
        return result
      }),
    )
    expect(started.processId).toBeDefined()
    expect(environment.killed).toEqual(["running"])
  })
})
