import { ModelRegistry } from "@batonfx/core"
import { Effect, Function, Layer, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

const schemasFor = (toolkit: Toolkit.Any): ReadonlyMap<string, Schema.Top> =>
  new Map(
    Object.values(toolkit.tools).map((tool) => [
      tool.name,
      Schema.isSchema(tool.parametersSchema) ? Schema.toEncoded(tool.parametersSchema) : Schema.Struct({}),
    ]),
  )

const providerTool = (tool: Tool.Any, schemas: ReadonlyMap<string, Schema.Top>): Tool.Any => {
  const parameters = schemas.get(tool.name)
  if (parameters === undefined) return tool
  return Tool.dynamic(tool.name, {
    ...(Tool.getDescription(tool) === undefined ? {} : { description: Tool.getDescription(tool) }),
    parameters,
    success: tool.successSchema,
    failure: tool.failureSchema,
    failureMode: tool.failureMode,
    ...(tool.needsApproval === undefined ? {} : { needsApproval: tool.needsApproval }),
  })
}

const providerToolkit = (
  toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>,
  schemas: ReadonlyMap<string, Schema.Top>,
): Toolkit.WithHandler<Record<string, Tool.Any>> => ({
  tools: Object.fromEntries(Object.values(toolkit.tools).map((tool) => [tool.name, providerTool(tool, schemas)])),
  handle: toolkit.handle,
})

const coerce = <A>(input: unknown): A => input as A
const isEffectInput = (input: unknown): boolean => Effect.isEffect(input)

const providerToolkitInput = (input: unknown, schemas: ReadonlyMap<string, Schema.Top>): unknown => {
  if (isEffectInput(input))
    return Effect.map(
      coerce<Effect.Effect<Toolkit.WithHandler<Record<string, Tool.Any>>, never, never>>(input),
      (toolkit) => providerToolkit(toolkit, schemas),
    )
  if (typeof input === "object" && input !== null && "tools" in input && "handle" in input)
    return providerToolkit(input as Toolkit.WithHandler<Record<string, Tool.Any>>, schemas)
  return input
}

const providerOptions = (input: unknown, schemas: ReadonlyMap<string, Schema.Top>): unknown => {
  if (typeof input !== "object" || input === null || !("toolkit" in input)) return input
  return { ...input, toolkit: providerToolkitInput(input.toolkit, schemas) }
}

const providerModel = (
  model: LanguageModel.Service,
  schemas: ReadonlyMap<string, Schema.Top>,
): LanguageModel.Service => ({
  ...model,
  generateText: ((options: never) => model.generateText(providerOptions(options, schemas) as never)) as never,
  streamText: ((options: never) =>
    model.streamText(providerOptions(options, schemas) as never) as Stream.Stream<never, never, never>) as never,
})

const withProviderToolWireSchemasImpl = (
  registration: ModelRegistry.Registration,
  toolkit: Toolkit.Any,
): ModelRegistry.Registration => {
  const schemas = schemasFor(toolkit)
  return {
    ...registration,
    layer: Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.LanguageModel.pipe(Effect.map((model) => providerModel(model, schemas))),
    ).pipe(Layer.provideMerge(registration.layer)),
  }
}

export const withProviderToolWireSchemas: {
  (registration: ModelRegistry.Registration, toolkit: Toolkit.Any): ModelRegistry.Registration
  (toolkit: Toolkit.Any): (registration: ModelRegistry.Registration) => ModelRegistry.Registration
} = Function.dual(2, withProviderToolWireSchemasImpl)

export const providerWireSchema = (tool: Tool.Any): Schema.Top =>
  Schema.isSchema(tool.parametersSchema) ? Schema.toEncoded(tool.parametersSchema) : Schema.Struct({})
