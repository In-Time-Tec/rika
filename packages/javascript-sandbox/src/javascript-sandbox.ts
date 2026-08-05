import { ProgramCapabilities, SandboxExecutor } from "@batonfx/core"
import { Cause, Clock, Effect, Layer, Option, Schema } from "effect"
import quickJsVariant from "@jitl/quickjs-singlefile-cjs-release-sync"
import quickJsPackage from "@jitl/quickjs-singlefile-cjs-release-sync/package.json" with { type: "json" }
import {
  isFail,
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core"

const capabilityNames = [
  "discoverTools",
  "describeTool",
  "callTool",
  "callStep",
  "runAgent",
  "mapAgents",
  "fanOutAgents",
  "log",
] as const

type CapabilityName = (typeof capabilityNames)[number]

export interface Options {
  readonly memoryBytes?: number
  readonly stackBytes?: number
}

const modulePromise = newQuickJSWASMModuleFromVariant(quickJsVariant)
const textEncoder = new TextEncoder()
const defaultMemoryBytes = 64 * 1024 * 1024
const defaultStackBytes = 512 * 1024
const guestSettlementInterval = "1 millis"

const language = "javascript"
const quickJsImplementation = "quickjs-singlefile-cjs-release-sync"
const quickJsVersion = quickJsPackage.version

export const Identity = Schema.Struct({
  language: Schema.Literal(language),
  implementation: Schema.Literal(quickJsImplementation),
  version: Schema.Literal(quickJsVersion),
  memoryBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  stackBytes: Schema.Int.check(Schema.isGreaterThan(0)),
})

export type Identity = typeof Identity.Type

const configuredLimit = (value: number | undefined, defaultValue: number, name: string): number => {
  const limit = value ?? defaultValue
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  return limit
}

export const identity = (options: Options = {}): Identity =>
  Object.freeze({
    language,
    implementation: quickJsImplementation,
    version: quickJsVersion,
    memoryBytes: configuredLimit(options.memoryBytes, defaultMemoryBytes, "memoryBytes"),
    stackBytes: configuredLimit(options.stackBytes, defaultStackBytes, "stackBytes"),
  })

export const productionIdentity = identity()

const member = Schema.Struct({ member: ProgramCapabilities.ProgramMemberKey, input: Schema.Unknown })
const agentResult = Schema.Struct({
  text: Schema.String,
  turns: Schema.Finite,
  tokenUsage: Schema.Struct({ input: Schema.Finite, output: Schema.Finite }),
})
const memberResult = Schema.Struct({ member: ProgramCapabilities.ProgramMemberKey, result: agentResult })

const protocolViolation = (message: string) => SandboxExecutor.SandboxProtocolViolation.make({ message })
const executionFailure = (message: string) => SandboxExecutor.SandboxExecutionFailure.make({ message })

const encodeJson = (value: unknown, boundary: string): string => {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error("value is not JSON-encodable")
    return encoded
  } catch (cause) {
    throw protocolViolation(`${boundary}: ${String(cause)}`)
  }
}

const decodeJson = (encoded: string, boundary: string): unknown => {
  try {
    return JSON.parse(encoded)
  } catch (cause) {
    throw protocolViolation(`${boundary}: ${String(cause)}`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requireRecord = (value: unknown, operation: CapabilityName): Record<string, unknown> => {
  if (!isRecord(value)) throw protocolViolation(`${operation} input must be an object`)
  return value
}

const requireString = (record: Record<string, unknown>, key: string, operation: CapabilityName): string => {
  const value = record[key]
  if (typeof value !== "string") throw protocolViolation(`${operation}.${key} must be a string`)
  return value
}

const requireArray = (
  record: Record<string, unknown>,
  key: string,
  operation: CapabilityName,
): ReadonlyArray<unknown> => {
  const value = record[key]
  if (!Array.isArray(value)) throw protocolViolation(`${operation}.${key} must be an array`)
  return value
}

const decodeCapabilityInput = (operation: CapabilityName, encoded: string): unknown => {
  const value = decodeJson(encoded, `${operation} input`)
  if (operation === "discoverTools") {
    if (value !== null) throw protocolViolation("discoverTools input must be null")
    return null
  }
  if (operation === "describeTool") {
    if (typeof value !== "string") throw protocolViolation("describeTool input must be a string")
    return value
  }
  const record = requireRecord(value, operation)
  requireString(record, "operation", operation)
  if (operation === "callTool") requireString(record, "tool", operation)
  if (operation === "callStep") requireString(record, "step", operation)
  if (operation === "runAgent" || operation === "mapAgents") requireString(record, "selection", operation)
  if (operation === "mapAgents" || operation === "fanOutAgents") requireArray(record, "members", operation)
  if (operation === "log") {
    requireString(record, "level", operation)
    requireString(record, "message", operation)
  }
  return record
}

const validateCapabilityInput = (operation: CapabilityName, value: unknown): unknown => {
  const schema = (() => {
    switch (operation) {
      case "discoverTools":
        return Schema.Null
      case "describeTool":
        return Schema.String
      case "callTool":
        return Schema.Struct({
          operation: ProgramCapabilities.ProgramOperationName,
          tool: Schema.String,
          input: Schema.Unknown,
        })
      case "callStep":
        return Schema.Struct({
          operation: ProgramCapabilities.ProgramOperationName,
          step: Schema.String,
          input: Schema.Unknown,
        })
      case "runAgent":
        return Schema.Struct({
          operation: ProgramCapabilities.ProgramOperationName,
          selection: Schema.String,
          input: Schema.Unknown,
        })
      case "mapAgents":
        return Schema.Struct({
          operation: ProgramCapabilities.ProgramOperationName,
          selection: Schema.String,
          members: Schema.Array(member),
        })
      case "fanOutAgents":
        return Schema.Struct({
          operation: ProgramCapabilities.ProgramOperationName,
          members: Schema.Array(Schema.Struct({ ...member.fields, selection: Schema.String })),
        })
      case "log":
        return Schema.Struct({
          operation: ProgramCapabilities.ProgramOperationName,
          level: ProgramCapabilities.LogLevel,
          message: Schema.String,
          data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        })
    }
  })()
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch (cause) {
    throw protocolViolation(`${operation} input: ${String(cause)}`)
  }
}

const validateCapabilityOutput = (operation: CapabilityName, value: unknown): unknown => {
  const schema = (() => {
    switch (operation) {
      case "discoverTools":
        return Schema.Array(Schema.Struct({ name: Schema.String }))
      case "describeTool":
        return Schema.Struct({ name: Schema.String, inputSchema: Schema.Json, outputSchema: Schema.Json })
      case "runAgent":
        return agentResult
      case "mapAgents":
      case "fanOutAgents":
        return Schema.Array(memberResult)
      case "log":
        return Schema.Null
      case "callTool":
      case "callStep":
        return Schema.Unknown
    }
  })()
  try {
    return Schema.decodeUnknownSync(schema)(operation === "log" ? null : value)
  } catch (cause) {
    throw protocolViolation(`${operation} output: ${String(cause)}`)
  }
}

const capabilityFailure = (cause: Cause.Cause<unknown>): ProgramCapabilities.CapabilityFailure | undefined => {
  const failure = Cause.findErrorOption(cause)
  if (Option.isNone(failure)) return undefined
  return Schema.is(ProgramCapabilities.CapabilityFailure)(failure.value) ? failure.value : undefined
}

const classifyGuestFailure = (
  context: QuickJSContext,
  handle: Parameters<QuickJSContext["dump"]>[0],
): SandboxExecutor.ExecutionFailure => {
  const value: unknown = context.dump(handle)
  const message = isRecord(value) && typeof value.message === "string" ? value.message : String(value)
  try {
    return Schema.decodeUnknownSync(SandboxExecutor.ExecutionFailure)(value)
  } catch {
    return executionFailure(message)
  }
}

const toExecutionFailure = (cause: unknown): SandboxExecutor.ExecutionFailure =>
  Schema.is(SandboxExecutor.ExecutionFailure)(cause) ? cause : executionFailure(String(cause))

const cancelled = () => ProgramCapabilities.ProgramCancelled.make({ reason: "Program execution cancelled" })

const runCapability = (
  capabilities: ProgramCapabilities.Interface,
  operation: CapabilityName,
  input: unknown,
): Effect.Effect<unknown, ProgramCapabilities.CapabilityFailure> => {
  switch (operation) {
    case "discoverTools":
      return capabilities.discoverTools()
    case "describeTool":
      return capabilities.describeTool(input as string)
    case "callTool":
      return capabilities.callTool(input as ProgramCapabilities.ToolCallInput)
    case "callStep":
      return capabilities.callStep(input as ProgramCapabilities.StepCallInput)
    case "runAgent":
      return capabilities.runAgent(input as ProgramCapabilities.AgentRunInput)
    case "mapAgents":
      return capabilities.mapAgents(input as ProgramCapabilities.AgentMapInput)
    case "fanOutAgents":
      return capabilities.fanOutAgents(input as ProgramCapabilities.AgentFanOutInput)
    case "log":
      return capabilities.log(input as ProgramCapabilities.LogInput)
  }
}

const installGuestCapabilityBridge = (
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  capabilities: ProgramCapabilities.Interface,
  signal: AbortSignal,
  deferred: Set<QuickJSDeferredPromise>,
) => {
  const hostCall = context.newFunction("__rikaCapabilityCall", (operationHandle, inputHandle) => {
    const pending = context.newPromise()
    deferred.add(pending)
    if (context.typeof(operationHandle) !== "string" || context.typeof(inputHandle) !== "string") {
      const handle = context.newString(
        encodeJson(protocolViolation("Capability protocol accepts only encoded strings"), "protocol failure"),
      )
      pending.reject(handle)
      handle.dispose()
      deferred.delete(pending)
      return pending.handle
    }
    const operationValue = context.getString(operationHandle)
    if (!capabilityNames.includes(operationValue as CapabilityName)) {
      const handle = context.newString(
        encodeJson(protocolViolation(`Unknown capability operation: ${operationValue}`), "protocol failure"),
      )
      pending.reject(handle)
      handle.dispose()
      deferred.delete(pending)
      return pending.handle
    }
    const operation = operationValue as CapabilityName
    let input: unknown
    try {
      input = validateCapabilityInput(operation, decodeCapabilityInput(operation, context.getString(inputHandle)))
    } catch (cause) {
      const failure = Schema.is(SandboxExecutor.ExecutionFailure)(cause)
        ? cause
        : protocolViolation(`${operation} input is invalid`)
      const handle = context.newString(encodeJson(failure, "protocol failure"))
      pending.reject(handle)
      handle.dispose()
      deferred.delete(pending)
      return pending.handle
    }
    const settle = (success: boolean, value: unknown) => {
      if (!pending.alive || !context.alive) return
      const encoded = encodeJson(success ? validateCapabilityOutput(operation, value) : value, `${operation} output`)
      const handle = context.newString(encoded)
      try {
        if (success) pending.resolve(handle)
        else pending.reject(handle)
      } finally {
        handle.dispose()
        deferred.delete(pending)
      }
      runtime.executePendingJobs()
    }
    Effect.runPromiseExit(runCapability(capabilities, operation, input), { signal }).then(
      (exit) => {
        if (exit._tag === "Success") settle(true, exit.value)
        else settle(false, capabilityFailure(exit.cause) ?? protocolViolation(`${operation} capability failed`))
      },
      () => settle(false, cancelled()),
    )
    return pending.handle
  })
  context.setProp(context.global, "__rikaCapabilityCall", hostCall)
  hostCall.dispose()
}

const guestSource = (source: string, input: unknown) => `
(async () => {
  "use strict"
  const call = globalThis.__rikaCapabilityCall
  delete globalThis.__rikaCapabilityCall
  const invoke = (operation, input) => call(operation, JSON.stringify(input)).then(
    (encoded) => JSON.parse(encoded),
    (encoded) => { throw JSON.parse(encoded) },
  )
  const capabilities = Object.freeze({
    discoverTools: () => invoke("discoverTools", null),
    describeTool: (name) => invoke("describeTool", name),
    callTool: (request) => invoke("callTool", request),
    callStep: (request) => invoke("callStep", request),
    runAgent: (request) => invoke("runAgent", request),
    mapAgents: (request) => invoke("mapAgents", request),
    fanOutAgents: (request) => invoke("fanOutAgents", request),
    log: (request) => invoke("log", request),
  })
  const input = JSON.parse(${JSON.stringify(encodeJson(input, "program input"))})
  return await (async (input, capabilities) => {
    "use strict"
${source}
  })(input, capabilities)
})()
`

const execute =
  (options: Identity): SandboxExecutor.Interface["execute"] =>
  (request) =>
    Effect.gen(function* () {
      if (!Number.isFinite(request.limits.wallTimeMillis) || request.limits.wallTimeMillis < 0)
        return yield* protocolViolation("wallTimeMillis must be a non-negative finite number")
      if (!Number.isFinite(request.limits.outputBytes) || request.limits.outputBytes < 0)
        return yield* protocolViolation("outputBytes must be a non-negative finite number")
      const { wallTimeMillis, outputBytes } = request.limits
      const capabilities = yield* ProgramCapabilities.ProgramCapabilities
      const clock = yield* Clock.Clock
      const localController = new AbortController()
      const signal = AbortSignal.any([request.signal, localController.signal])
      const { context, deferred, runtime } = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => modulePromise,
          catch: () => SandboxExecutor.SandboxUnavailable.make({ language }),
        }).pipe(
          Effect.flatMap((module) =>
            Effect.try({
              try: () => {
                const created = module.newRuntime({
                  memoryLimitBytes: options.memoryBytes,
                  maxStackSizeBytes: options.stackBytes,
                })
                return {
                  context: created.newContext(),
                  deferred: new Set<QuickJSDeferredPromise>(),
                  runtime: created,
                }
              },
              catch: () => SandboxExecutor.SandboxUnavailable.make({ language }),
            }),
          ),
        ),
        (resource) =>
          Effect.sync(() => {
            localController.abort()
            for (const pending of resource.deferred) pending.dispose()
            if (resource.context.alive) resource.context.dispose()
            if (resource.runtime.alive) resource.runtime.dispose()
          }),
      )
      const deadline = (yield* Clock.currentTimeMillis) + wallTimeMillis
      const boundaryFailure = (
        now: number,
        failure: SandboxExecutor.ExecutionFailure,
      ): SandboxExecutor.ExecutionFailure => {
        if (now >= deadline)
          return ProgramCapabilities.ProgramBudgetExhausted.make({
            dimension: "wallClockMillis",
            limit: wallTimeMillis,
          })
        return signal.aborted ? cancelled() : failure
      }
      runtime.setInterruptHandler(() => signal.aborted || clock.currentTimeMillisUnsafe() >= deadline)
      installGuestCapabilityBridge(context, runtime, capabilities, signal, deferred)
      const settled = (handle: QuickJSHandle): Effect.Effect<unknown, SandboxExecutor.ExecutionFailure> =>
        Effect.gen(function* () {
          const state = context.getPromiseState(handle)
          if (state.type === "fulfilled") {
            const value = context.dump(state.value)
            state.value.dispose()
            return value
          }
          if (state.type === "rejected") {
            const failure = classifyGuestFailure(context, state.error)
            state.error.dispose()
            return yield* failure
          }
          if ((yield* Clock.currentTimeMillis) >= deadline) {
            localController.abort()
            return yield* executionFailure("Program execution timed out")
          }
          if (signal.aborted) return yield* cancelled()
          yield* Effect.sleep(guestSettlementInterval)
          return yield* settled(handle)
        })
      const evaluated = yield* Effect.try({
        try: () => context.evalCode(guestSource(request.source, request.input), request.sourceDigest),
        catch: toExecutionFailure,
      })
      const output = yield* Effect.suspend(() => {
        if (isFail(evaluated)) {
          const failure = classifyGuestFailure(context, evaluated.error)
          evaluated.error.dispose()
          return Effect.fail(failure)
        }
        const jobs = runtime.executePendingJobs()
        if (isFail(jobs)) {
          const failure = classifyGuestFailure(jobs.error.context, jobs.error)
          jobs.error.dispose()
          evaluated.value.dispose()
          return Effect.fail(failure)
        }
        return Effect.ensuring(
          settled(evaluated.value),
          Effect.sync(() => evaluated.value.dispose()),
        )
      }).pipe(
        Effect.catch((failure) =>
          Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.fail(boundaryFailure(now, failure)))),
        ),
      )
      const encodedOutput = encodeJson(output, "program output")
      const encodedOutputBytes = textEncoder.encode(encodedOutput).byteLength
      if (encodedOutputBytes > outputBytes)
        return yield* ProgramCapabilities.ProgramBudgetExhausted.make({
          dimension: "outputBytes",
          limit: outputBytes,
        })
      return decodeJson(encodedOutput, "program output")
    })

export const make = (options: Options = {}): SandboxExecutor.Interface => {
  const value = identity(options)
  return SandboxExecutor.SandboxExecutor.of({ identity: value, execute: execute(value) })
}

export const layer = (options: Options = {}): Layer.Layer<InstanceType<typeof SandboxExecutor.SandboxExecutor>> =>
  Layer.succeed(SandboxExecutor.SandboxExecutor, make(options))
