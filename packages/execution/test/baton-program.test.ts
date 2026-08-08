import { expect, it } from "@effect/vitest"
import { ExecutableManifest, ProgramManifest, SandboxExecutor } from "@batonfx/core"
import { ExecutableRegistration } from "@batonfx/runtime"
import * as RoleToolkits from "@rika/tools/agent-role-toolkits"
import * as JavaScriptSandbox from "@rika/sandbox/javascript-sandbox"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import type { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { configure, makeResolver } from "../src/baton-route"
import { authority as makeAuthority, budget, maxSourceBytes, pins, schemas } from "../src/baton-program"
import * as Sandbox from "../src/baton-sandbox-identity"

const registrationJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const invocationExit = <A, E>(invocation: { readonly execute: Effect.Effect<A, E> }) => Effect.exit(invocation.execute)

const apiKeySecret = "sk-live-rika-fixture-secret-value"
const bearerToken = "bearer-fixture-token-value"

const agentServices = () =>
  RoleToolkits.root.toLayer(
    Object.fromEntries(
      Object.keys(RoleToolkits.root.tools).map((name) => [
        name,
        () => Effect.succeed({ text: `${name} result`, truncated: false }),
      ]),
    ) as never,
  ) as Layer.Layer<any, never, never>

const sandbox = JavaScriptSandbox.make()
const identity = JavaScriptSandbox.productionIdentity
const sandboxPin = (workspace: string) => pins.sandbox(identity, workspace)

const testSandbox = SandboxExecutor.makeTest(() => Effect.succeed({ summary: "done" }))

const withCredentials = (model: ExecutionRouteSnapshot["main"]) => ({
  ...model,
  candidates: model.candidates.map((candidate) => ({
    ...candidate,
    providerConnection: {
      ...candidate.providerConnection,
      apiKeyEnvironment: "RIKA_FIXTURE_API_KEY",
      credentialIdentity: "rika-fixture-credential",
    },
  })),
})

const credentialRoute = (): ExecutionRouteSnapshot => {
  const route = testExecutionRoute()
  return {
    ...route,
    title: withCredentials(route.title),
    compactionSummary: withCredentials(route.compactionSummary),
    main: withCredentials(route.main),
    oracle: withCredentials(route.oracle),
    agents: {
      librarian: withCredentials(route.agents.librarian),
      painter: withCredentials(route.agents.painter),
      readThread: withCredentials(route.agents.readThread),
      review: withCredentials(route.agents.review),
      surgeon: withCredentials(route.agents.surgeon),
      task: withCredentials(route.agents.task),
    },
  }
}

const narrow = (
  authority: ReturnType<typeof makeAuthority>,
  manifest: ExecutableManifest.ExecutableManifest,
  options: {
    readonly source: string
    readonly tools: ReadonlyArray<string>
    readonly agents: ReadonlyArray<string>
  },
) => {
  const tools = options.tools.map((name) => {
    const capability = authority.tools.find((entry) => entry.name === name)
    if (capability === undefined) throw new Error(`unauthorized tool ${name}`)
    return capability
  })
  const agents = options.agents.map((selection) => {
    const capability = authority.agents.find((entry) => entry.selection === selection)
    if (capability === undefined) throw new Error(`unauthorized Agent ${selection}`)
    return capability
  })
  const pinned = ProgramManifest.make({
    name: "code_mode:test",
    source: { language: "javascript", text: options.source },
    sandbox: authority.sandbox,
    input: authority.input,
    output: authority.output,
    capabilities: { tools, agents, steps: [] },
    budget: { ...authority.budget, toolCalls: 4 },
  })
  const reachable = new Set<string>()
  const visit = (pin: string): void => {
    if (reachable.has(pin)) return
    const entry = manifest.entries.find((candidate) => candidate.pin === pin)
    if (entry?._tag !== "Agent") throw new Error(`missing Agent entry ${pin}`)
    reachable.add(pin)
    for (const child of [...entry.manifest.children, ...(entry.manifest.programAuthority?.agents ?? [])])
      visit(child.agent)
  }
  for (const agent of agents) visit(agent.agent)
  return ExecutableManifest.make({
    root: pinned.pin,
    entries: [
      { _tag: "Program", ...pinned },
      ...[...reachable].map((pin) => {
        const entry = manifest.entries.find((candidate) => candidate.pin === pin)!
        if (entry._tag !== "Agent") throw new Error(`missing Agent entry ${pin}`)
        return { _tag: "Agent" as const, pin: entry.pin, manifest: entry.manifest }
      }),
    ],
  })
}

it.effect("pins one exact root Program authority over approved tools, Agents, steps, and budget", () =>
  Effect.gen(function* () {
    const configured = yield* configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox })
    const root = configured.executable.manifest.entries.find(({ pin }) => pin === configured.executable.ref.active)
    expect(root?._tag).toBe("Agent")
    const authority = root?._tag === "Agent" ? root.manifest.programAuthority : undefined
    expect(authority).toBeDefined()
    expect(authority).toEqual(configured.programAuthority)
    expect(authority?.sandbox).toBe(sandboxPin("/workspace"))
    expect(authority?.input).toBe(pins.input)
    expect(authority?.output).toBe(pins.output)
    expect(authority?.maxSourceBytes).toBe(maxSourceBytes)
    expect(authority?.budget).toEqual(budget)
    expect(authority?.steps).toEqual([])
    expect(authority?.tools.map(({ name }) => name)).toEqual(Object.keys(RoleToolkits.root.tools).toSorted())
    expect(authority?.agents.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "ReadThread",
      "Surgeon",
      "Task",
    ])
    expect(authority?.agents.every(({ input }) => input === pins.agentInput)).toBe(true)
    for (const capability of authority?.agents ?? []) {
      expect(
        configured.executable.manifest.entries.some(
          (entry) => entry._tag === "Agent" && entry.pin === capability.agent,
        ),
      ).toBe(true)
    }
    for (const entry of configured.executable.manifest.entries) {
      if (entry._tag !== "Agent" || entry.pin === configured.executable.ref.active) continue
      expect(entry.manifest.programAuthority).toBeUndefined()
    }
  }),
)

it.effect("registers every pin the admitted executable requires with a typed secret-free payload", () =>
  Effect.gen(function* () {
    const configured = yield* configure({ executionRoute: credentialRoute(), workspace: "/workspace", sandbox })
    const validated = yield* ExecutableRegistration.validate(configured.executable, configured.registrations)
    expect(validated.length).toBe(configured.registrations.length)
    const required = ExecutableRegistration.requiredPins(configured.executable)
    expect(new Set(configured.registrations.map(({ pin }) => pin))).toEqual(required)
    expect(required.has(sandboxPin("/workspace"))).toBe(true)
    expect(required.has(pins.input)).toBe(true)
    expect(required.has(pins.output)).toBe(true)
    expect(required.has(pins.agentInput)).toBe(true)
    expect(configured.registrations.find(({ pin }) => pin === sandboxPin("/workspace"))).toMatchObject({
      codec: "rika-program-sandbox",
      version: "1",
      payload: Sandbox.payload(identity, "/workspace"),
    })
    expect(configured.registrations.find(({ pin }) => pin === pins.input)?.payload).toEqual({
      schema: schemas.inputDocument,
    })
    expect(configured.registrations.find(({ pin }) => pin === pins.output)?.payload).toEqual({
      schema: schemas.outputDocument,
    })
    expect(configured.registrations.find(({ pin }) => pin === pins.agentInput)?.payload).toEqual({
      schema: schemas.agentInputDocument,
    })
  }),
)

it.effect("persists credential references but never an API key, token, or resolved credential value", () =>
  Effect.gen(function* () {
    const configured = yield* configure({ executionRoute: credentialRoute(), workspace: "/workspace", sandbox })
    const payloads = registrationJson(configured.registrations.map(({ payload }) => payload))
    expect(payloads).toContain("RIKA_FIXTURE_API_KEY")
    expect(payloads).toContain("rika-fixture-credential")
    for (const secret of [apiKeySecret, bearerToken, "Authorization", "x-api-key"]) {
      expect(payloads).not.toContain(secret)
    }
    for (const registration of configured.registrations) {
      const encoded = registrationJson(registration.payload)
      expect(/"(apiKey|token|secret|password|credentialValue|authorization)"\s*:/i.test(encoded)).toBe(false)
    }
  }),
)

it.effect("resolves a narrowed Program executable with the exact admitted sandbox, schemas, and bindings", () =>
  Effect.gen(function* () {
    const configured = yield* configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox })
    const executable = narrow(configured.programAuthority, configured.executable.manifest, {
      source: "export default async () => ({ summary: 'done' })",
      tools: ["grep", "read"],
      agents: ["Oracle"],
    })
    const registrations = yield* ExecutableRegistration.narrow(executable, configured.registrations)
    expect(registrations.length).toBeLessThan(configured.registrations.length)
    const resolver = makeResolver({ agentServices, sandbox })
    const resolution = yield* Effect.scoped(
      resolver.resolve({
        runId: "run_code_1",
        ref: executable.ref,
        manifest: executable.manifest,
        registrations,
      }),
    )
    expect(resolution._tag).toBe("Program")
    if (resolution._tag !== "Program") return
    expect(resolution.attestation.ref).toEqual(executable.ref)
    expect(resolution.attestation.manifest).toEqual(executable.manifest)
    expect(resolution.sandbox).toBe(sandbox)
    expect(resolution.program.pinned.pin).toBe(executable.ref.active)
    expect(resolution.program.input).toBe(schemas.input)
    expect(resolution.program.output).toBe(schemas.output)
    expect(resolution.bindings.tools.map(({ name }) => name)).toEqual(["grep", "read"])
    expect(resolution.bindings.tools.map(({ replay }) => replay)).toEqual(["idempotent", "idempotent"])
    expect(resolution.bindings.steps).toEqual([])
    expect(resolution.bindings.agents.map(({ selection }) => selection)).toEqual(["Oracle"])
    expect(resolution.bindings.agents.every(({ inputPin }) => inputPin === pins.agentInput)).toBe(true)
    const grep = resolution.bindings.tools.find(({ name }) => name === "grep")!
    const grepCall = yield* grep.decode({ pattern: "rika", regex: false })
    expect(yield* invocationExit(grepCall)).toEqual(Exit.succeed({ text: "grep result", truncated: false }))
    const oracle = resolution.bindings.agents[0]!
    const oracleCall = yield* oracle.decode("analyze")
    expect(Exit.isFailure(yield* invocationExit(oracleCall))).toBe(true)
  }),
)

it.effect("rejects a changed, extra, or missing registration for both root and narrowed executables", () =>
  Effect.gen(function* () {
    const configured = yield* configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox })
    const resolver = makeResolver({ agentServices, sandbox })
    const resolveWith = (
      executable: ExecutableManifest.PinnedExecutable,
      registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>,
    ) =>
      Effect.exit(
        Effect.scoped(
          resolver.resolve({
            runId: "run_1",
            ref: executable.ref,
            manifest: executable.manifest,
            registrations,
          }),
        ),
      )
    const root = yield* resolveWith(configured.executable, configured.registrations)
    expect(Exit.isSuccess(root)).toBe(true)

    const changedPin = configured.registrations.find(({ codec }) => codec === "rika-tool")!.pin
    const changed = configured.registrations.map((registration) =>
      registration.pin === changedPin
        ? { ...registration, payload: { name: "grep", description: "changed", schema: {} } }
        : registration,
    )
    const changedExit = yield* resolveWith(configured.executable, changed)
    expect(Exit.isFailure(changedExit)).toBe(true)

    const missing = configured.registrations.filter(({ pin }) => pin !== sandboxPin("/workspace"))
    const missingExit = yield* resolveWith(configured.executable, missing)
    expect(Exit.isFailure(missingExit)).toBe(true)

    const executable = narrow(configured.programAuthority, configured.executable.manifest, {
      source: "export default async () => ({ summary: 'done' })",
      tools: ["read"],
      agents: ["Surgeon"],
    })
    const narrowed = yield* ExecutableRegistration.narrow(executable, configured.registrations)
    expect(Exit.isSuccess(yield* resolveWith(executable, narrowed))).toBe(true)
    const extra = [...narrowed, configured.registrations.find(({ pin }) => !narrowed.some((r) => r.pin === pin))!]
    expect(Exit.isFailure(yield* resolveWith(executable, extra))).toBe(true)
  }),
)

it.effect("binds Program capabilities to the persisted workspace and to a configured sandbox", () =>
  Effect.gen(function* () {
    const configured = yield* configure({ executionRoute: testExecutionRoute(), workspace: "/one", sandbox })
    const executable = narrow(configured.programAuthority, configured.executable.manifest, {
      source: "export default async () => ({ summary: 'done' })",
      tools: ["read"],
      agents: ["Task"],
    })
    const registrations = yield* ExecutableRegistration.narrow(executable, configured.registrations)
    const observed: Array<string> = []
    const input = {
      runId: "run_code_workspace",
      ref: executable.ref,
      manifest: executable.manifest,
      registrations,
    }
    const resolution = yield* Effect.scoped(
      makeResolver({
        agentServices: (workspace) => {
          observed.push(workspace)
          return agentServices()
        },
        sandbox,
      }).resolve(input),
    )
    expect(observed).toEqual(["/one"])
    expect(resolution._tag).toBe("Program")

    const other = yield* configure({ executionRoute: testExecutionRoute(), workspace: "/two", sandbox })
    expect(other.programAuthority.sandbox).not.toBe(configured.programAuthority.sandbox)

    const withoutServices = yield* Effect.exit(Effect.scoped(makeResolver({ sandbox }).resolve(input)))
    expect(Exit.isFailure(withoutServices)).toBe(true)
  }),
)

it.effect("rejects a Program capability that Rika never admitted", () =>
  Effect.gen(function* () {
    const configured = yield* configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox })
    const outside = ProgramManifest.make({
      name: "code_mode:escape",
      source: { language: "javascript", text: "export default async () => ({ summary: 'x' })" },
      sandbox: configured.programAuthority.sandbox,
      input: configured.programAuthority.input,
      output: configured.programAuthority.output,
      capabilities: {
        tools: [{ name: "read", pin: configured.programAuthority.output }],
        agents: [],
        steps: [],
      },
      budget: configured.programAuthority.budget,
    })
    const executable = ExecutableManifest.make({
      root: outside.pin,
      entries: [{ _tag: "Program", ...outside }],
    })
    const registrations = yield* ExecutableRegistration.narrow(executable, configured.registrations)
    const resolution = yield* Effect.exit(
      Effect.scoped(
        makeResolver({ agentServices, sandbox }).resolve({
          runId: "run_escape",
          ref: executable.ref,
          manifest: executable.manifest,
          registrations,
        }),
      ),
    )
    expect(Exit.isFailure(resolution)).toBe(true)
  }),
)

const executorWith = (patch: Record<string, unknown>) =>
  SandboxExecutor.makeTest(() => Effect.succeed({ summary: "done" }), { ...identity, ...patch })

it.effect("pins and persists every field of the running sandbox executor identity", () =>
  Effect.gen(function* () {
    const admitted = yield* configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox })
    const admittedPayload = admitted.registrations.find(({ pin }) => pin === admitted.programAuthority.sandbox)!
    expect(admittedPayload.payload).toEqual({ ...identity, workspace: "/workspace" })
    const variants = {
      implementation: "quickjs-other-variant",
      version: "0.0.1-changed",
      memoryBytes: identity.memoryBytes + 4096,
      stackBytes: identity.stackBytes + 4096,
    }
    for (const [field, value] of Object.entries(variants)) {
      const changed = yield* configure({
        executionRoute: testExecutionRoute(),
        workspace: "/workspace",
        sandbox: executorWith({ [field]: value }),
      })
      expect(changed.programAuthority.sandbox).not.toBe(admitted.programAuthority.sandbox)
      const payload = changed.registrations.find(({ pin }) => pin === changed.programAuthority.sandbox)!.payload
      expect(payload).toEqual({ ...identity, [field]: value, workspace: "/workspace" })
    }
    const workspaceChanged = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/other",
      sandbox,
    })
    expect(workspaceChanged.programAuthority.sandbox).not.toBe(admitted.programAuthority.sandbox)
    const rejected = yield* Effect.exit(
      configure({
        executionRoute: testExecutionRoute(),
        workspace: "/workspace",
        sandbox: executorWith({ language: "python" }),
      }),
    )
    expect(Exit.isFailure(rejected)).toBe(true)
    const untyped = yield* Effect.exit(
      configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox: testSandbox }),
    )
    expect(Exit.isFailure(untyped)).toBe(true)
  }),
)

const admittedProgramInput = Effect.gen(function* () {
  const configured = yield* configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", sandbox })
  const executable = narrow(configured.programAuthority, configured.executable.manifest, {
    source: "export default async () => ({ summary: 'done' })",
    tools: ["read"],
    agents: ["Oracle"],
  })
  const registrations = yield* ExecutableRegistration.narrow(executable, configured.registrations)
  return {
    configured,
    executable,
    input: { runId: "run_identity", ref: executable.ref, manifest: executable.manifest, registrations },
  }
})

const resolveExit = (
  resolverSandbox: SandboxExecutor.Interface,
  input: {
    readonly runId: string
    readonly ref: ExecutableManifest.PinnedExecutable["ref"]
    readonly manifest: ExecutableManifest.ExecutableManifest
    readonly registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>
  },
) => Effect.exit(Effect.scoped(makeResolver({ agentServices, sandbox: resolverSandbox }).resolve(input)))

const failure = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "resolved"

it.effect("refuses an admitted Program under a test or changed sandbox executor identity", () =>
  Effect.gen(function* () {
    const admitted = yield* admittedProgramInput
    expect(Exit.isSuccess(yield* resolveExit(sandbox, admitted.input))).toBe(true)
    expect(failure(yield* resolveExit(testSandbox, admitted.input))).toContain(
      "sandbox executor identity is not admitted by Rika",
    )
    expect(
      failure(yield* resolveExit(JavaScriptSandbox.make({ memoryBytes: 32 * 1024 * 1024 }), admitted.input)),
    ).toContain("Program sandbox is not admitted by Rika")
    expect(failure(yield* resolveExit(executorWith({ version: "0.0.1-changed" }), admitted.input))).toContain(
      "Program sandbox is not admitted by Rika",
    )
  }),
)

it.effect("refuses a tampered sandbox registration payload that keeps the admitted pin", () =>
  Effect.gen(function* () {
    const admitted = yield* admittedProgramInput
    const tamper = (payload: unknown) =>
      admitted.input.registrations.map((registration) =>
        registration.pin === admitted.configured.programAuthority.sandbox ? { ...registration, payload } : registration,
      )
    for (const payload of [
      { ...Sandbox.payload(identity, "/workspace"), memoryBytes: identity.memoryBytes + 4096 },
      { ...Sandbox.payload(identity, "/workspace"), stackBytes: identity.stackBytes + 4096 },
      { ...Sandbox.payload(identity, "/workspace"), implementation: "quickjs-other-variant" },
      { ...Sandbox.payload(identity, "/workspace"), version: "0.0.1-changed" },
    ]) {
      const exit = yield* resolveExit(sandbox, { ...admitted.input, registrations: tamper(payload) })
      expect(failure(exit)).toContain("Program sandbox identity does not match the running sandbox executor")
    }
    const relocated = yield* resolveExit(sandbox, {
      ...admitted.input,
      registrations: tamper(Sandbox.payload(identity, "/elsewhere")),
    })
    expect(failure(relocated)).toContain("Program sandbox is not admitted by Rika")
  }),
)

it.effect("refuses tampered Program input, output, and Agent input schema payloads", () =>
  Effect.gen(function* () {
    const admitted = yield* admittedProgramInput
    for (const pin of [pins.input, pins.output, pins.agentInput]) {
      const registrations = admitted.input.registrations.map((registration) =>
        registration.pin === pin ? { ...registration, payload: { schema: { tampered: true } } } : registration,
      )
      expect(registrations.some((registration) => registration.pin === pin)).toBe(true)
      expect(failure(yield* resolveExit(sandbox, { ...admitted.input, registrations }))).toContain(
        "schema payload does not match the Rika executable",
      )
    }
  }),
)

it.effect("encodes the exact Program input and output schemas crossing the sandbox boundary", () =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(schemas.input)(Prompt.make("review the diff"))
    expect(encoded).toEqual({ instruction: "review the diff" })
    const decoded = yield* Schema.decodeUnknownEffect(schemas.input)({ instruction: "review the diff" })
    expect(Prompt.isPrompt(decoded)).toBe(true)
    expect(yield* Schema.decodeUnknownEffect(schemas.output)({ summary: "done", data: { count: 2 } })).toEqual({
      summary: "done",
      data: { count: 2 },
    })
    expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(schemas.output)({ data: {} })))).toBe(true)
  }),
)
