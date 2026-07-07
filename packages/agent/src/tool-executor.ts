import { Config, Diagnostics } from "@rika/core"
import { Common, ErrorEnvelope } from "@rika/schema"
import type { Call, Result } from "@rika/schema/tool"
import { Context, Effect, Layer, Schema } from "effect"
import type { Tool } from "effect/unstable/ai"
import * as PermissionPolicy from "./permission-policy"
import * as ToolAccess from "./tool-access"
import * as ToolRegistry from "./tool-registry"

export type Descriptor = ToolRegistry.Descriptor
export const Descriptor = ToolRegistry.Descriptor

export class ToolExecutorError extends Schema.TaggedErrorClass<ToolExecutorError>()("ToolExecutorError", {
  message: Schema.String,
  kind: Schema.optional(ErrorEnvelope.ErrorKind),
  name: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Interface {
  readonly tools: Effect.Effect<ReadonlyArray<Tool.Any>>
  readonly describe: Effect.Effect<ReadonlyArray<Descriptor>>
  readonly toolsWithDefinitions: (
    definitions: ReadonlyArray<ToolRegistry.Definition>,
  ) => Effect.Effect<ReadonlyArray<Tool.Any>>
  readonly describeWithDefinitions: (
    definitions: ReadonlyArray<ToolRegistry.Definition>,
  ) => Effect.Effect<ReadonlyArray<Descriptor>>
  readonly execute: (call: Call) => Effect.Effect<Result>
  readonly executeWithDefinitions: (
    call: Call,
    definitions: ReadonlyArray<ToolRegistry.Definition>,
  ) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/ToolExecutor") {}

export type FakeHandler = ToolRegistry.FakeHandler

const makeExecutor = (
  registry: ToolRegistry.Interface,
  policy: PermissionPolicy.Interface,
  diagnostics: Diagnostics.Interface,
): Interface => ({
  tools: registry.tools,
  describe: registry.describe,
  toolsWithDefinitions: (definitions) => registryWithDefinitions(registry, definitions).tools,
  describeWithDefinitions: (definitions) => registryWithDefinitions(registry, definitions).describe,
  execute: Effect.fn("ToolExecutor.execute")(function* (call: Call) {
    return yield* Diagnostics.event(
      "tool.exec",
      (fields) => runExecute(registry, policy, call, fields),
      executeSeed(call),
    ).pipe(Effect.provideService(Diagnostics.Service, diagnostics))
  }),
  executeWithDefinitions: Effect.fn("ToolExecutor.executeWithDefinitions")(function* (
    call: Call,
    definitions: ReadonlyArray<ToolRegistry.Definition>,
  ) {
    const turnRegistry = registryWithDefinitions(registry, definitions)
    return yield* Diagnostics.event(
      "tool.exec",
      (fields) => runExecute(turnRegistry, policy, call, fields),
      executeSeed(call),
    ).pipe(Effect.provideService(Diagnostics.Service, diagnostics))
  }),
})

const registryWithDefinitions = (
  registry: ToolRegistry.Interface,
  definitions: ReadonlyArray<ToolRegistry.Definition>,
): ToolRegistry.Interface => {
  if (definitions.length === 0) return registry
  return {
    tools: registry.tools.pipe(
      Effect.map((tools) => [
        ...tools,
        ...definitionsWithoutCollisions(new Set(tools.map((tool) => tool.name)), definitions).map(
          (definition) => definition.tool,
        ),
      ]),
    ),
    describe: registry.describe.pipe(
      Effect.map((descriptors) => {
        const selected = definitionsWithoutCollisions(
          new Set(descriptors.map((descriptor) => descriptor.name)),
          definitions,
        )
        return [...descriptors, ...selected.map((definition) => ToolRegistry.descriptorFromTool(definition.tool))]
      }),
    ),
    execute: Effect.fn("ToolExecutor.extraRegistry.execute")(function* (call: Call) {
      const tools = yield* registry.tools
      if (tools.some((tool) => tool.name === call.name)) return yield* registry.execute(call)
      const definitionsByName = definitionsWithoutCollisions(new Set(tools.map((tool) => tool.name)), definitions)
      const definition = definitionsByName.find((candidate) => candidate.tool.name === call.name)
      if (definition !== undefined) return yield* definition.execute(call)
      return yield* registry.execute(call)
    }),
  }
}

const definitionsWithoutCollisions = (
  blockedNames: Set<string>,
  definitions: ReadonlyArray<ToolRegistry.Definition>,
): ReadonlyArray<ToolRegistry.Definition> => {
  const selected: Array<ToolRegistry.Definition> = []
  for (const definition of definitions) {
    const name = definition.tool.name
    if (blockedNames.has(name)) continue
    blockedNames.add(name)
    selected.push(definition)
  }
  return selected
}

const executeSeed = (call: Call): Diagnostics.Fields => {
  const threadId = call.metadata?.thread_id
  const turnId = call.metadata?.turn_id
  return {
    tool_name: call.name,
    tool_call_id: call.id,
    input_size: jsonSize(call.input),
    ...(threadId === undefined ? {} : { thread_id: threadId }),
    ...(turnId === undefined ? {} : { turn_id: turnId }),
  }
}

const runExecute = (
  registry: ToolRegistry.Interface,
  policy: PermissionPolicy.Interface,
  call: Call,
  fields: Diagnostics.Fields,
) =>
  Effect.gen(function* () {
    const toolAccess = ToolAccess.metadataToolAccess(call.metadata)
    const mode = yield* policy.mode
    if (ToolAccess.isReadOnlyTurn(toolAccess) && !ToolAccess.isReadOnlyToolName(call.name)) {
      fields.permission_mode = mode
      fields.permission_action = "reject-and-continue"
      const result = withMetadata(
        errorResult(
          call,
          new ToolExecutorError({
            message: `Tool ${call.name} is not available during read-only turns`,
            kind: "permission",
            name: call.name,
            retryable: false,
          }),
        ),
        { ...permissionMetadata(mode, "reject-and-continue"), tool_access: "read-only" },
      )
      fields.status = result.status
      fields.output_size = 0
      fields.error_kind = "permission"
      return result
    }
    const decision = yield* policy.decide(call).pipe(
      Effect.match({
        onFailure: (error) => PermissionPolicy.reject(error.message, error.details),
        onSuccess: (allowed) => allowed,
      }),
    )
    fields.permission_mode = mode
    fields.permission_action = decision.action
    const resultMetadata = ToolAccess.isReadOnlyTurn(toolAccess)
      ? { ...permissionMetadata(mode, decision.action), tool_access: "read-only" }
      : permissionMetadata(mode, decision.action)
    const result = yield* resultForDecision(registry, call, decision, resultMetadata)
    fields.status = result.status
    fields.output_size = result.output === undefined ? 0 : jsonSize(result.output)
    if (result.status === "error" && result.error !== undefined) {
      fields.error_kind = result.error.kind
    }
    return result
  })

const resultForDecision = (
  registry: ToolRegistry.Interface,
  call: Call,
  decision: PermissionPolicy.Decision,
  metadata: Common.Metadata,
) =>
  Effect.gen(function* () {
    switch (decision.action) {
      case "allow":
        return yield* executeRegistryCall(registry, call).pipe(Effect.map((result) => withMetadata(result, metadata)))
      case "modify":
        return yield* executeRegistryCall(registry, modifiedCall(call, decision.input)).pipe(
          Effect.map((result) => withMetadata(result, metadata)),
        )
      case "reject-and-continue":
        return withMetadata(
          errorResult(
            call,
            new ToolExecutorError({
              message: decision.message,
              kind: "permission",
              name: call.name,
              retryable: false,
              ...(decision.details === undefined ? {} : { details: decision.details }),
            }),
          ),
          metadata,
        )
      case "synthesize":
        return withMetadata(normalizeSynthesizedResult(call, decision.result), metadata)
      default:
        return yield* Effect.die(new Error("Unknown permission policy decision"))
    }
  })

const jsonSize = (value: Common.JsonValue): number => JSON.stringify(value)?.length ?? 0

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const policy = yield* PermissionPolicy.Service
    const diagnostics = yield* Diagnostics.Service
    return Service.of(makeExecutor(registry, policy, diagnostics))
  }),
)

export class ReadOnlyService extends Context.Service<ReadOnlyService, Interface>()(
  "@rika/agent/ReadOnlyToolExecutor",
) {}

export class SubagentService extends Context.Service<SubagentService, Interface>()(
  "@rika/agent/SubagentToolExecutor",
) {}

export const readOnlyLayer = Layer.effect(
  ReadOnlyService,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const policy = yield* PermissionPolicy.Service
    const diagnostics = yield* Diagnostics.Service
    return ReadOnlyService.of(makeExecutor(registry, policy, diagnostics))
  }),
)

export const subagentLayer = Layer.effect(
  SubagentService,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const policy = yield* PermissionPolicy.Service
    const diagnostics = yield* Diagnostics.Service
    return SubagentService.of(makeExecutor(registry, policy, diagnostics))
  }),
)

export const emptyLayer = layer.pipe(
  Layer.provideMerge(ToolRegistry.emptyLayer),
  Layer.provideMerge(PermissionPolicy.allowLayer),
)

export const fakeLayer = (handlers: Readonly<Record<string, FakeHandler>>, tools?: ReadonlyArray<Tool.Any>) =>
  layer.pipe(
    Layer.provideMerge(ToolRegistry.fakeLayer(handlers, tools)),
    Layer.provideMerge(PermissionPolicy.allowLayer),
  )

export const fakeReadOnlyLayer = (handlers: Readonly<Record<string, FakeHandler>>, tools?: ReadonlyArray<Tool.Any>) =>
  readOnlyLayer.pipe(
    Layer.provideMerge(ToolRegistry.fakeLayer(handlers, tools)),
    Layer.provideMerge(PermissionPolicy.allowLayer),
  )

export const fakeSubagentLayer = (handlers: Readonly<Record<string, FakeHandler>>, tools?: ReadonlyArray<Tool.Any>) =>
  subagentLayer.pipe(
    Layer.provideMerge(ToolRegistry.fakeLayer(handlers, tools)),
    Layer.provideMerge(PermissionPolicy.allowLayer),
  )

export const shellLayer: Layer.Layer<Service, never, Config.Service | Diagnostics.Service> = layer.pipe(
  Layer.provideMerge(ToolRegistry.shellLayer),
  Layer.provideMerge(PermissionPolicy.allowLayer),
)

export const describe = Effect.fn("ToolExecutor.describe.call")(function* () {
  const executor = yield* Service
  return yield* executor.describe
})

export const tools = Effect.fn("ToolExecutor.tools.call")(function* () {
  const executor = yield* Service
  return yield* executor.tools
})

export const execute = Effect.fn("ToolExecutor.execute.call")(function* (call: Call) {
  const executor = yield* Service
  return yield* executor.execute(call)
})

export const executeWithDefinitions = Effect.fn("ToolExecutor.executeWithDefinitions.call")(function* (
  call: Call,
  definitions: ReadonlyArray<ToolRegistry.Definition>,
) {
  const executor = yield* Service
  return yield* executor.executeWithDefinitions(call, definitions)
})

const executeRegistryCall = (registry: ToolRegistry.Interface, call: Call) =>
  registry.execute(call).pipe(
    Effect.match({
      onFailure: (error) => errorResult(call, fromRegistryError(error)),
      onSuccess: (output) => successResult(call, output),
    }),
  )

const modifiedCall = (call: Call, input: Common.JsonValue): Call => ({
  ...call,
  input,
  metadata: { ...call.metadata, permission_action: "modify" },
})

const normalizeSynthesizedResult = (call: Call, result: Result): Result => ({
  ...result,
  id: call.id,
  name: call.name,
})

const permissionMetadata = (
  mode: PermissionPolicy.PermissionMode,
  action: PermissionPolicy.Decision["action"],
): Common.Metadata => ({
  permission_mode: mode,
  permission_action: action,
})

const withMetadata = (result: Result, metadata: Common.Metadata): Result => ({
  ...result,
  metadata: { ...result.metadata, ...metadata },
})

const fromRegistryError = (error: ToolRegistry.ToolRegistryError) =>
  new ToolExecutorError({
    message: error.message,
    kind: "tool",
    ...(error.name === undefined ? {} : { name: error.name }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.details === undefined ? {} : { details: error.details }),
  })

export const successResult = (call: Call, output: Common.JsonValue): Result => ({
  id: call.id,
  name: call.name,
  status: "success",
  output,
})

export const errorResult = (call: Call, error: ToolExecutorError): Result => ({
  id: call.id,
  name: call.name,
  status: "error",
  error: errorEnvelope(error),
})

export const errorEnvelope = (error: ToolExecutorError): ErrorEnvelope.Envelope => ({
  kind: error.kind ?? "tool",
  message: error.message,
  ...(error.name === undefined ? {} : { code: error.name }),
  ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
  ...(error.details === undefined ? {} : { details: error.details }),
})
