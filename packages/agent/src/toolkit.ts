import { Provider } from "@rika/llm"
import { Common, Ids } from "@rika/schema"
import type { Call, Result } from "@rika/schema/tool"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Tool } from "effect/unstable/ai"
import { Toolkit } from "effect/unstable/ai"
import * as ToolExecutor from "./tool-executor"

export interface Prepared {
  readonly toolkit: Provider.ToolkitInput
}

export interface Interface {
  readonly build: Effect.Effect<Prepared>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/Toolkit") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const toolExecutor = yield* ToolExecutor.Service
    return Service.of({
      build: Effect.gen(function* () {
        const tools = yield* toolExecutor.tools
        return prepare(tools, toolExecutor.execute)
      }),
    })
  }),
)

export const layerFromPrepared = (prepared: Prepared) =>
  Layer.succeed(
    Service,
    Service.of({
      build: Effect.succeed(prepared),
    }),
  )

export const prepare = (
  tools: ReadonlyArray<Tool.Any>,
  execute: (call: Call) => Effect.Effect<Result>,
): Prepared => {
  const toolkit = Toolkit.make(...tools)
  const handlers = toolkit.of(
    Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        (input: unknown) =>
          execute({
            id: Ids.ToolCallId.make("toolkit"),
            name: tool.name,
            input: inputJson(input),
          }),
      ]),
    ),
  )
  return { toolkit: Effect.provide(toolkit, toolkit.toLayer(handlers)) }
}

const inputJson = (input: unknown): Common.JsonValue => {
  const decoded = Schema.decodeUnknownOption(Common.JsonValue)(input)
  if (Option.isSome(decoded)) return decoded.value
  return {}
}
