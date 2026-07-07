import { Provider } from "@rika/llm"
import { Context, Effect, Layer } from "effect"
import { AiError, Toolkit, type Tool } from "effect/unstable/ai"
import * as ToolAccess from "./tool-access"
import * as ToolExecutor from "./tool-executor"
import * as ToolRegistry from "./tool-registry"

export interface Prepared {
  readonly toolkit: Provider.ToolkitInput
}

export interface BuildInput {
  readonly tool_access?: ToolAccess.TurnToolAccess
  readonly definitions?: ReadonlyArray<ToolRegistry.Definition>
}

export interface Interface {
  readonly build: (input?: BuildInput) => Effect.Effect<Prepared>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/Toolkit") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const toolExecutor = yield* ToolExecutor.Service
    return Service.of({
      build: (input) =>
        Effect.gen(function* () {
          const definitions = input?.definitions ?? []
          const tools = yield* toolExecutor.toolsWithDefinitions(definitions)
          return prepare(ToolAccess.filterTools(tools, input?.tool_access))
        }),
    })
  }),
)

export const layerFromPrepared = (prepared: Prepared) =>
  Layer.succeed(
    Service,
    Service.of({
      build: () => Effect.succeed(prepared),
    }),
  )

export const prepare = (tools: ReadonlyArray<Tool.Any>): Prepared => {
  const toolkit = Toolkit.make(...tools)
  return {
    toolkit: {
      tools: toolkit.tools,
      handle: (name) =>
        Effect.fail(
          AiError.make({
            module: "Rika.Toolkit",
            method: "handle",
            reason: new AiError.ToolConfigurationError({
              toolName: String(name),
              description:
                "Rika resolves model tool calls manually through ToolExecutor after provider tool.call stream events.",
            }),
          }),
        ),
    },
  }
}
