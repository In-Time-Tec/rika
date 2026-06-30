import { Config } from "@rika/core"
import { Common, ErrorEnvelope } from "@rika/schema"
import type { Call, Result } from "@rika/schema/tool"
import { Context, Effect, Layer, Schema } from "effect"
import type { Tool } from "effect/unstable/ai"
import * as PermissionPolicy from "./permission-policy"
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
  readonly execute: (call: Call) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/ToolExecutor") {}

export type FakeHandler = ToolRegistry.FakeHandler

const makeExecutor = (registry: ToolRegistry.Interface, policy: PermissionPolicy.Interface): Interface => ({
  tools: registry.tools,
  describe: registry.describe,
  execute: Effect.fn("ToolExecutor.execute")(function* (call: Call) {
    const mode = yield* policy.mode
    const decision = yield* policy.decide(call).pipe(
      Effect.match({
        onFailure: (error) => PermissionPolicy.reject(error.message, error.details),
        onSuccess: (allowed) => allowed,
      }),
    )
    const metadata = permissionMetadata(mode, decision.action)

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
  }),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const policy = yield* PermissionPolicy.Service
    return Service.of(makeExecutor(registry, policy))
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
    return ReadOnlyService.of(makeExecutor(registry, policy))
  }),
)

export const subagentLayer = Layer.effect(
  SubagentService,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const policy = yield* PermissionPolicy.Service
    return SubagentService.of(makeExecutor(registry, policy))
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

export const shellLayer: Layer.Layer<Service, never, Config.Service> = layer.pipe(
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
