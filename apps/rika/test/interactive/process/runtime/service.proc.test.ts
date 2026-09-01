import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, layer } from "@effect/vitest"
import * as LocalTools from "@rika/execution/local-tools"
import * as ToolResult from "@rika/product/native-tool-result"
import * as ToolRuntime from "@rika/product/native-tool-runtime"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { Response } from "effect/unstable/ai"
import { ToolContext, ToolExecutor } from "generalist"

const bashRequest = (command: string): ToolExecutor.Request => {
  const call = Schema.decodeSync(Response.ToolCallPart("bash", Schema.Unknown))({
    type: "tool-call",
    id: "call-bash",
    name: "bash",
    params: { command, timeout_ms: 0 },
    providerExecuted: false,
  })
  return {
    call,
    toolCallBatch: { calls: [call] },
    turn: 0,
    toolCallIndex: 0,
    agentName: "rika-root",
    sessionId: "local-tools-process",
  }
}

const toolContext = ToolContext.layerTest({
  signal: new AbortController().signal,
  emit: () => Effect.succeed(true),
  sessionId: "local-tools-process",
})

layer(BunServices.layer)("local tool process registry", (it) => {
  it.effect("polls a model-started process through the recorded-shell runtime", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-local-tools-process-" })
      const context = yield* Layer.build(
        Layer.merge(LocalTools.layer(workspace).pipe(Layer.provide(BunServices.layer)), toolContext),
      )
      const executor = Context.get(context, ToolExecutor.ToolExecutor)
      const runtime = Context.get(context, ToolRuntime.Service)
      const outcome = yield* executor.execute(bashRequest("sleep 5")).pipe(Effect.provide(context))
      expect(outcome._tag).toBe("Success")
      if (outcome._tag !== "Success") return yield* Effect.die("expected successful background bash")
      const started = yield* Schema.decodeUnknownEffect(ToolResult.Result)(outcome.encodedResult)
      const status = yield* runtime.run({
        _tag: "ShellCommandStatus",
        processId: started.processId ?? "",
        waitMillis: 0,
      })
      expect(status.processId).toBe(started.processId)
      expect(status.running).toBe(true)
    }),
  )
})
