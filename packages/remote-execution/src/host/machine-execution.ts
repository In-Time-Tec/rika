import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { MediaAnalysisError, analyzerTestLayer } from "@rika/coding-tools/media-view-service"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { MachineOutcome, MachineRequest } from "../protocol/messages"

export type Requirements = CodingToolRuntime.Service | ShellProcessRegistry.Service | McpRuntime.McpRuntimeService

export const execute = (request: MachineRequest): Effect.Effect<MachineOutcome, never, Requirements> => {
  switch (request._tag) {
    case "CodingTool":
      return Effect.flatMap(CodingToolRuntime.Service, (runtime) => runtime.run(request.request)).pipe(
        Effect.match({
          onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
          onSuccess: (result) => ({ _tag: "Success" as const, value: { _tag: "CodingTool" as const, result } }),
        }),
      )
    case "ProcessStop":
      return Effect.flatMap(ShellProcessRegistry.Service, (processes) => processes.cancel(request.processId)).pipe(
        Effect.match({
          onFailure: (failure) => ({
            _tag: "Failure" as const,
            failure: { _tag: "ProcessStopFailed" as const, message: failure.message },
          }),
          onSuccess: () => ({ _tag: "Success" as const, value: { _tag: "ProcessStopped" as const } }),
        }),
      )
    case "McpDiscover":
      return Effect.scoped(McpRuntime.discover(request.server)).pipe(
        Effect.match({
          onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
          onSuccess: (tools) => ({ _tag: "Success" as const, value: { _tag: "McpDiscovered" as const, tools } }),
        }),
      )
    case "McpCall":
      return Effect.scoped(McpRuntime.call(request.server, request.tool, request.input)).pipe(
        Effect.match({
          onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
          onSuccess: (content) => ({ _tag: "Success" as const, value: { _tag: "McpCalled" as const, content } }),
        }),
      )
  }
}

export const layer = (workspace: string) => {
  const tools = Layer.orDie(
    CodingToolRuntime.layerWithRegistry(workspace).pipe(
      Layer.provide(
        analyzerTestLayer(() => Effect.fail(MediaAnalysisError.make({ message: "Media analysis is unavailable" }))),
      ),
      Layer.provide(
        Layer.merge(WebSearch.factoryLayer([]), ReadWebPage.layer({})).pipe(Layer.provide(FetchHttpClient.layer)),
      ),
    ),
  )
  return Layer.merge(tools, McpRuntime.layer)
}
