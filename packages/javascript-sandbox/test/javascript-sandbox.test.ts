import { ProgramCapabilities, SandboxExecutor } from "@batonfx/core"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import * as JavaScriptSandbox from "../src/javascript-sandbox"

interface ExecuteOptions {
  readonly capabilities?: ProgramCapabilities.Interface
  readonly input?: unknown
  readonly outputBytes?: number
  readonly sandboxOptions?: JavaScriptSandbox.Options
  readonly signal?: AbortSignal
  readonly wallTimeMillis?: number
}

const defaultCapabilities = ProgramCapabilities.ProgramCapabilities.of({
  discoverTools: () => Effect.succeed([]),
  describeTool: (name) => Effect.fail(ProgramCapabilities.ProgramCapabilityMissing.make({ capability: name })),
  callTool: (input) => Effect.fail(ProgramCapabilities.ProgramCapabilityMissing.make({ capability: input.tool })),
  callStep: (input) => Effect.fail(ProgramCapabilities.ProgramCapabilityMissing.make({ capability: input.step })),
  runAgent: (input) => Effect.fail(ProgramCapabilities.ProgramCapabilityMissing.make({ capability: input.selection })),
  mapAgents: (input) => Effect.fail(ProgramCapabilities.ProgramCapabilityMissing.make({ capability: input.selection })),
  fanOutAgents: () => Effect.fail(ProgramCapabilities.ProgramCapabilityMissing.make({ capability: "agents" })),
  log: () => Effect.void,
})

const execute = (source: string, options: ExecuteOptions = {}) =>
  Effect.scoped(
    JavaScriptSandbox.make(options.sandboxOptions)
      .execute({
        language: "javascript",
        source,
        sourceDigest: "test-source",
        input: options.input ?? null,
        signal: options.signal ?? new AbortController().signal,
        limits: {
          wallTimeMillis: options.wallTimeMillis ?? 1_000,
          outputBytes: options.outputBytes ?? 16_384,
        },
      })
      .pipe(
        Effect.provideService(ProgramCapabilities.ProgramCapabilities, options.capabilities ?? defaultCapabilities),
      ),
  )

const failureOf = <E>(effect: Effect.Effect<unknown, E>): Effect.Effect<E> =>
  Effect.result(effect).pipe(
    Effect.flatMap((result) =>
      result._tag === "Failure"
        ? Effect.succeed(result.failure)
        : Effect.die(new Error(`expected a sandbox failure, produced ${JSON.stringify(result.success)}`)),
    ),
  )

const executeFailure = (source: string, options: ExecuteOptions = {}) => failureOf(execute(source, options))

const budgetExhausted = (failure: SandboxExecutor.ExecutionFailure) => {
  if (failure._tag !== "@batonfx/core/ProgramBudgetExhausted")
    throw new Error(`expected ProgramBudgetExhausted, received ${failure._tag}`)
  return failure
}

it("exports a stable immutable QuickJS identity with memory and stack configuration", () => {
  const baseline = JavaScriptSandbox.productionIdentity
  const identities = [
    JavaScriptSandbox.identity({ memoryBytes: baseline.memoryBytes + 1 }),
    JavaScriptSandbox.identity({ stackBytes: baseline.stackBytes + 1 }),
  ]
  expect(baseline).toEqual({
    language: "javascript",
    implementation: "quickjs-singlefile-cjs-release-sync",
    version: "0.32.0",
    memoryBytes: 64 * 1024 * 1024,
    stackBytes: 512 * 1024,
  })
  expect(Object.isFrozen(baseline)).toBe(true)
  expect(identities).not.toContainEqual(baseline)
  expect(new Set(identities.map((identity) => JSON.stringify(identity))).size).toBe(2)
  expect(JavaScriptSandbox.make().identity).toEqual(baseline)
  expect(JavaScriptSandbox.make({ stackBytes: baseline.stackBytes + 1 }).identity).toEqual({
    ...baseline,
    stackBytes: baseline.stackBytes + 1,
  })
})

it.live("calls the explicit async Program capabilities with encoded values", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = []
    const capabilities = ProgramCapabilities.ProgramCapabilities.of({
      ...defaultCapabilities,
      callTool: (input) =>
        Effect.sync(() => {
          calls.push(input)
          return { answer: (input.input as number) + 1 }
        }),
    })
    const output = yield* execute(
      `return await capabilities.callTool({ operation: "increment", tool: "math", input: input.value })`,
      { capabilities, input: { value: 41 } },
    )
    expect(output).toEqual({ answer: 42 })
    expect(calls).toEqual([{ operation: "increment", tool: "math", input: 41 }])
  }),
)

it.live("provides no ambient process, environment, filesystem, network, or module globals", () =>
  execute(`
    return {
      process: typeof process,
      Bun: typeof Bun,
      require: typeof require,
      fetch: typeof fetch,
      WebSocket: typeof WebSocket,
      Deno: typeof Deno,
      hostCall: typeof globalThis.__rikaCapabilityCall,
    }
  `).pipe(
    Effect.map((output) =>
      expect(output).toEqual({
        process: "undefined",
        Bun: "undefined",
        require: "undefined",
        fetch: "undefined",
        WebSocket: "undefined",
        Deno: "undefined",
        hostCall: "undefined",
      }),
    ),
  ),
)

it.live("interrupts active and suspended source at the wall-time limit", () =>
  Effect.gen(function* () {
    const active = yield* executeFailure("while (true) {}", { wallTimeMillis: 5 })
    expect(budgetExhausted(active).dimension).toBe("wallClockMillis")
    const suspended = yield* executeFailure("return await new Promise(() => {})", { wallTimeMillis: 5 })
    expect(budgetExhausted(suspended).dimension).toBe("wallClockMillis")
  }),
)

it.live("cancels a pending capability call from the request AbortSignal", () =>
  Effect.gen(function* () {
    // @effect-diagnostics-next-line abortControllerInEffect:off
    const controller = new AbortController()
    const started = yield* Deferred.make<void>()
    let interrupted = false
    const capabilities = ProgramCapabilities.ProgramCapabilities.of({
      ...defaultCapabilities,
      callTool: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
        ),
    })
    const fiber = yield* execute(
      `return await capabilities.callTool({ operation: "wait", tool: "wait", input: null })`,
      { capabilities, signal: controller.signal },
    ).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    controller.abort()
    const failure = yield* failureOf(Fiber.join(fiber))
    expect(failure).toBeInstanceOf(ProgramCapabilities.ProgramCancelled)
    expect(interrupted).toBe(true)
  }),
)

it.live("rejects encoded output above the byte limit", () =>
  Effect.gen(function* () {
    const failure = yield* executeFailure(`return "0123456789"`, { outputBytes: 5 })
    expect(budgetExhausted(failure).dimension).toBe("outputBytes")
  }),
)

it.live("reports the exact request limits when output or wall time is exhausted", () =>
  Effect.gen(function* () {
    const outputFailure = yield* executeFailure(`return "0123456789"`, { outputBytes: 5 })
    expect(budgetExhausted(outputFailure).limit).toBe(5)
    const timeFailure = yield* executeFailure("while (true) {}", { wallTimeMillis: 5 })
    expect(budgetExhausted(timeFailure).limit).toBe(5)
  }),
)

it.live("maps thrown guest errors to SandboxExecutionFailure", () =>
  Effect.gen(function* () {
    const failure = yield* executeFailure(`throw new Error("guest exploded")`)
    if (failure._tag !== "@batonfx/core/SandboxExecutionFailure")
      throw new Error(`expected SandboxExecutionFailure, received ${failure._tag}`)
    expect(failure.message).toContain("guest exploded")
  }),
)

it.live("rejects malformed capability calls as protocol violations", () =>
  Effect.gen(function* () {
    const failure = yield* executeFailure(`return await capabilities.callTool(null)`)
    expect(failure).toBeInstanceOf(SandboxExecutor.SandboxProtocolViolation)
  }),
)

it.live("contains constructor and prototype escape attempts inside QuickJS", () =>
  execute(`
    const HostFunction = ({}).constructor.constructor
    const inspect = HostFunction("return ({ process: typeof process, Bun: typeof Bun, require: typeof require, fetch: typeof fetch })")
    const before = inspect()
    Object.prototype.process = "guest-only"
    return { ...before, guestMutation: typeof globalThis.process, capabilityKeys: Object.keys(capabilities).sort() }
  `).pipe(
    Effect.map((output) =>
      expect(output).toEqual({
        process: "undefined",
        Bun: "undefined",
        require: "undefined",
        fetch: "undefined",
        guestMutation: "string",
        capabilityKeys: [
          "callStep",
          "callTool",
          "describeTool",
          "discoverTools",
          "fanOutAgents",
          "log",
          "mapAgents",
          "runAgent",
        ],
      }),
    ),
  ),
)
