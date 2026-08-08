import { expect, it } from "@effect/vitest"
import { ExecutableManifest, ModelRegistry, Pins, SandboxExecutor } from "@batonfx/core"
import { CodeMode, ExecutableRegistration } from "@batonfx/runtime"
import { TestModel } from "@batonfx/test"
import { Database } from "bun:sqlite"
import * as RoleToolkits from "@rika/tools/agent-role-toolkits"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import type { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Random, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import { layer } from "../src/baton-execution"
import { makeResolver } from "../src/baton-route"
import * as JavaScriptSandbox from "@rika/sandbox/javascript-sandbox"

const promptJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const budgetJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const registrationJson = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutableRegistration.ExecutableRegistration))
const registrationPayloadJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
const executableRefJson = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutableManifest.ExecutableRef))
const executableManifestJson = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutableManifest.ExecutableManifest))

interface ExecutableColumns {
  readonly executable_ref_json: string
  readonly executable_manifest_json: string
}

const executableOf = (row: ExecutableColumns): ExecutableManifest.PinnedExecutable => ({
  ref: executableRefJson(row.executable_ref_json),
  manifest: executableManifestJson(row.executable_manifest_json),
})

const source = `
const read = await capabilities.callTool({
  operation: "read-proof",
  tool: "read",
  input: { path: "proof.txt" },
})
const agent = await capabilities.runAgent({
  operation: "agent-proof",
  selection: "Oracle",
  input: "inspect the durable proof",
})
return { summary: "program complete", data: { read: read.text, agent: agent.text } }
`

const programBudget = {
  agentRuns: 1,
  concurrency: 1,
  toolCalls: 1,
  tokens: 10_000,
  wallClockMillis: 30_000,
  logBytes: 1_024,
  outputBytes: 16_384,
}

const resolvedCredentialValue = "code-mode-resolved-credential-4e6fdc91"

const credentialConfigProvider = ConfigProvider.fromEnv({
  env: { RIKA_CODE_MODE_API_KEY: resolvedCredentialValue },
})

const registryLayer = (fixture: TestModel.Fixture) =>
  ModelRegistry.layer([Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false })])

const routeWithIdentity = (identity: string): ExecutionRouteSnapshot => {
  const route = testExecutionRoute()
  const model = (value: ExecutionRouteSnapshot["main"]) => ({
    ...value,
    registrationIdentity: identity as typeof value.registrationIdentity,
    candidates: value.candidates.map((candidate) => ({
      ...candidate,
      registrationIdentity: identity as typeof candidate.registrationIdentity,
      providerConnection: {
        ...candidate.providerConnection,
        apiKeyEnvironment: "RIKA_CODE_MODE_API_KEY",
        credentialIdentity: "rika-code-mode-credential",
      },
    })),
  })
  return {
    ...route,
    title: model(route.title),
    compactionSummary: model(route.compactionSummary),
    main: model(route.main),
    oracle: model(route.oracle),
    agents: {
      librarian: model(route.agents.librarian),
      painter: model(route.agents.painter),
      readThread: model(route.agents.readThread),
      review: model(route.agents.review),
      surgeon: model(route.agents.surgeon),
      task: model(route.agents.task),
    },
  }
}

const codeMode = () =>
  TestModel.toolCall(
    "code_mode",
    {
      source,
      input: "execute the Rika Program",
      tools: ["read"],
      agents: ["Oracle"],
      steps: [],
      budget: programBudget,
    },
    { id: "code-mode-proof" },
  )

const agentServices = (calls: Array<string>) =>
  RoleToolkits.root.toLayer(
    Object.fromEntries(
      Object.keys(RoleToolkits.root.tools).map((name) => [
        name,
        () =>
          Effect.sync(() => {
            calls.push(name)
            return { text: `${name} capability result`, truncated: false }
          }),
      ]),
    ) as never,
  ) as Layer.Layer<any, never, never>

const executionLayer = (
  filename: string,
  fixture: TestModel.Fixture,
  calls: Array<string>,
  sandbox: Layer.Layer<InstanceType<typeof SandboxExecutor.SandboxExecutor>> = JavaScriptSandbox.layer(),
) =>
  layer({
    filename,
    modelServices: registryLayer(fixture),
    agentServices: () => agentServices(calls),
  }).pipe(Layer.provide(sandbox))

const input = (identity: string) => ({
  threadId: `thread-${identity}`,
  turnId: `turn-${identity}`,
  workspace: "/workspace/code-mode",
  prompt: "use Code Mode for the durable proof",
  executionRoute: routeWithIdentity(identity),
})

const readRuns = (filename: string) => {
  const database = new Database(filename, { readonly: true })
  const rows = database
    .query<
      {
        run_id: string
        parent_run_id: string | null
        invocation_id: string | null
        status: string
        executable_ref_json: string
        executable_manifest_json: string
      },
      []
    >(
      "SELECT run_id, parent_run_id, invocation_id, status, executable_ref_json, executable_manifest_json FROM baton_runs ORDER BY created_at, run_id",
    )
    .all()
  database.close()
  return rows
}

const awaitProgramAdmission = (filename: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = readRuns(filename)
      if (runs.some(({ invocation_id }) => invocation_id === "code-mode-proof")) return runs
      yield* Effect.sleep("1 millis")
    }
    return yield* Effect.die(new Error("Program child was not admitted"))
  })

const awaitCapabilityCall = (calls: ReadonlyArray<string>, capability: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (calls.includes(capability)) return
      yield* Effect.sleep("1 millis")
    }
    return yield* Effect.die(new Error(`Program did not call ${capability}`))
  })

const includesString = (value: unknown, expected: string): boolean => {
  if (typeof value === "string") return value === expected
  if (Array.isArray(value)) return value.some((entry) => includesString(entry, expected))
  if (value !== null && typeof value === "object")
    return Object.values(value).some((entry) => includesString(entry, expected))
  return false
}

const readResolverInput = (filename: string, runId: string) => {
  const database = new Database(filename, { readonly: true })
  const run = database
    .query<
      { executable_ref_json: string; executable_manifest_json: string },
      [string]
    >("SELECT executable_ref_json, executable_manifest_json FROM baton_runs WHERE run_id = ?")
    .get(runId)!
  const registrations = database
    .query<{ payload_json: string }, [string]>(
      "SELECT r.payload_json FROM baton_executable_registrations r JOIN baton_run_registrations l ON l.pin = r.pin WHERE l.run_id = ? ORDER BY r.pin",
    )
    .all(runId)
    .map(({ payload_json }) => registrationJson(payload_json))
  database.close()
  return { runId, ...executableOf(run), registrations }
}

const persistedRegistrationEvidence = (filename: string) => {
  const database = new Database(filename, { readonly: true })
  const payloads = database
    .query<
      { pin: string; payload_json: string },
      []
    >("SELECT pin, payload_json FROM baton_executable_registrations ORDER BY pin")
    .all()
  const links = database
    .query<{ run_id: string; pin: string }, []>("SELECT run_id, pin FROM baton_run_registrations ORDER BY run_id, pin")
    .all()
  const programRuns = database
    .query<
      { run_id: string; program_pin: string; budget_json: string },
      []
    >("SELECT run_id, program_pin, budget_json FROM baton_program_runs")
    .all()
  const tableNames = database
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(({ name }) => name)
  database.close()
  return { links, payloads, programRuns, tableNames }
}

it.live(
  "executes one real QuickJS Code Mode Program child and returns its result to the root once",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-code-mode-${yield* Random.nextInt}.db`
      const identity = "code-mode-route"
      const fixture = yield* TestModel.make(
        [
          TestModel.turn([codeMode()]),
          TestModel.turn([TestModel.text("Oracle capability result")]),
          TestModel.turn([TestModel.text("root complete")]),
        ],
        { provider: "test", model: "test", registrationKey: identity },
      )
      const toolCalls: Array<string> = []
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(executionLayer(filename, fixture, toolCalls))
          const gateway = Context.get(context, ExecutionGateway.Service)
          expect(Object.keys(gateway).toSorted()).toEqual([
            "approveTurn",
            "cancelTurn",
            "denyTurn",
            "inspectTurn",
            "startTurn",
            "steerTurn",
            "watchTurn",
          ])
          const link = yield* gateway.startTurn(input(identity))
          const events = yield* gateway.watchTurn(link).pipe(Stream.runCollect)
          return { events: [...events], link, status: yield* gateway.inspectTurn(link) }
        }),
      )

      const runs = readRuns(filename)
      const programChildren = runs.filter(
        ({ parent_run_id, invocation_id }) =>
          parent_run_id === result.link.runId && invocation_id === "code-mode-proof",
      )
      expect(programChildren).toHaveLength(1)
      expect(programChildren[0]?.run_id).toBe(
        `run_code_${Pins.digest({ parentRunId: result.link.runId, toolCallId: "code-mode-proof" }).slice(0, 32)}`,
      )
      expect(programChildren[0]?.status).toBe("succeeded")
      expect(result.status.status).toBe("completed")
      expect(result.events.at(-1)?.state.status).toBe("completed")
      expect(toolCalls).toEqual(["read"])

      const requests = yield* fixture.requests
      expect(requests).toHaveLength(3)
      expect(requests[0]?.tools.map(({ name }) => name)).toContain("code_mode")
      const resumedPrompt = promptJson(requests[2]?.prompt)
      expect(resumedPrompt.match(/"type":"tool-result"/g)).toHaveLength(1)
      expect(resumedPrompt).toContain("read capability result")
      expect(resumedPrompt).toContain("Oracle capability result")
    }),
  60_000,
)

it.live(
  "advertises exact Code Mode Agent authority, runs Task, and rejects lowercase task",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-code-mode-task-authority-${yield* Random.nextInt}.db`
      const identity = "code-mode-task-authority-route"
      const taskSource = `
const agent = await capabilities.runAgent({
  operation: "task-proof",
  selection: "Task",
  input: "complete the exact Task selection proof",
})
return { summary: "Task program complete", data: { agent: agent.text } }
`
      const request = {
        source: taskSource,
        input: "execute exact Task",
        tools: [],
        agents: ["Task"],
        steps: [],
        budget: programBudget,
      }
      const fixture = yield* TestModel.make(
        [
          TestModel.turn([TestModel.toolCall("code_mode", request, { id: "code-mode-task-proof" })]),
          TestModel.turn([TestModel.text("Task capability result")]),
          TestModel.turn([TestModel.text("root completed exact Task")]),
        ],
        { provider: "test", model: "test", registrationKey: identity },
      )
      const toolCalls: Array<string> = []
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(executionLayer(filename, fixture, toolCalls))
          const gateway = Context.get(context, ExecutionGateway.Service)
          const link = yield* gateway.startTurn(input(identity))
          const events = yield* gateway.watchTurn(link).pipe(Stream.runCollect)
          return { events: [...events], link, status: yield* gateway.inspectTurn(link) }
        }),
      )
      expect(result.status.status).toBe("completed")
      expect(readRuns(filename).find(({ invocation_id }) => invocation_id === "code-mode-task-proof")?.status).toBe(
        "succeeded",
      )
      expect(toolCalls).toEqual([])
      const requests = yield* fixture.requests
      expect(requests).toHaveLength(3)
      expect(promptJson(requests[2]?.prompt)).toContain("Task capability result")
      const declaration = requests[0]!.tools.find(({ name }) => name === "code_mode")!
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(Tool.getJsonSchema(declaration))).toContain(
        '"Task"',
      )
      const parameters = declaration.parametersSchema as ReturnType<typeof CodeMode.makeParameters>
      expect(yield* Schema.decodeUnknownEffect(parameters)({ ...request, agents: ["Task"] })).toMatchObject({
        agents: ["Task"],
      })
      expect(() => Schema.decodeUnknownSync(parameters)({ ...request, agents: ["task"] })).toThrow()
    }),
  60_000,
)

it.live("refuses to reconstruct an admitted Code Mode Program under a changed sandbox executor identity", () =>
  Effect.gen(function* () {
    const filename = `/tmp/rika-code-mode-identity-${yield* Random.nextInt}.db`
    const identity = "code-mode-identity-route"
    const fixture = yield* TestModel.make(
      [
        TestModel.turn([codeMode()]),
        TestModel.turn([TestModel.text("Oracle capability result")]),
        TestModel.turn([TestModel.text("root complete")]),
      ],
      { provider: "test", model: "test", registrationKey: identity },
    )
    const toolCalls: Array<string> = []
    const admitted = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(executionLayer(filename, fixture, toolCalls))
        const gateway = Context.get(context, ExecutionGateway.Service)
        const link = yield* gateway.startTurn(input(identity))
        return { link, runs: yield* awaitProgramAdmission(filename) }
      }),
    )
    const admittedProgram = admitted.runs.find(({ invocation_id }) => invocation_id === "code-mode-proof")!
    expect(admittedProgram.status).toBe("running")

    const persisted = readResolverInput(filename, admittedProgram.run_id)
    const refused = yield* Effect.exit(
      Effect.scoped(
        makeResolver({
          sandbox: JavaScriptSandbox.make({ memoryBytes: 32 * 1024 * 1024 }),
          agentServices: () => agentServices(toolCalls),
        }).resolve(persisted),
      ),
    )
    expect(Exit.isFailure(refused)).toBe(true)
    expect(Exit.isFailure(refused) ? Cause.pretty(refused.cause) : "").toContain(
      "Program sandbox is not admitted by Rika",
    )

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          executionLayer(filename, fixture, toolCalls, JavaScriptSandbox.layer({ memoryBytes: 32 * 1024 * 1024 })),
        )
        yield* Effect.sleep("2 seconds")
      }),
    )

    expect(toolCalls).toEqual([])
    expect(yield* fixture.requests).toHaveLength(1)
    expect(readRuns(filename).find(({ invocation_id }) => invocation_id === "code-mode-proof")?.status).not.toBe(
      "succeeded",
    )
  }),
)

it.live("cancels a running QuickJS Code Mode Program and preserves its terminal state across restart", () =>
  Effect.gen(function* () {
    const filename = `/tmp/rika-code-mode-cancel-${yield* Random.nextInt}.db`
    const identity = "code-mode-cancel-route"
    const fixture = yield* TestModel.make(
      [TestModel.turn([codeMode()]), TestModel.turn([TestModel.text("Oracle capability result")])],
      { provider: "test", model: "test", registrationKey: identity },
    )
    const toolCalls: Array<string> = []
    const cancelled = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(executionLayer(filename, fixture, toolCalls))
        const gateway = Context.get(context, ExecutionGateway.Service)
        const link = yield* gateway.startTurn(input(identity))
        yield* awaitProgramAdmission(filename)
        yield* awaitCapabilityCall(toolCalls, "read")
        yield* gateway.cancelTurn(link, "cancel the Code Mode Program")
        const events = yield* gateway.watchTurn(link).pipe(Stream.runCollect)
        return { events: [...events], link }
      }),
    )

    const cancelledProgram = readRuns(filename).find(({ invocation_id }) => invocation_id === "code-mode-proof")!
    expect(cancelledProgram.parent_run_id).toBe(cancelled.link.runId)
    expect(cancelledProgram.status).toBe("cancelled")
    expect(toolCalls).toEqual(["read"])
    expect(yield* fixture.requests).toHaveLength(1)
    expect(
      cancelled.events.some((change) =>
        (change._tag === "ProjectionSnapshot" ? change.units : change.upsert).some(
          (unit) =>
            unit.content._tag === "Block" &&
            unit.content.block._tag === "SubagentCard" &&
            unit.content.block.status === "cancelled",
        ),
      ),
    ).toBe(true)
    expect(cancelled.events.at(-1)?.state.status).toBe("cancelled")

    const restarted = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(executionLayer(filename, fixture, toolCalls))
        const gateway = Context.get(context, ExecutionGateway.Service)
        return {
          events: [...(yield* gateway.watchTurn(cancelled.link).pipe(Stream.runCollect))],
          status: yield* gateway.inspectTurn(cancelled.link),
        }
      }),
    )

    expect(restarted.status.status).toBe("cancelled")
    expect(restarted.events.at(-1)?.state.status).toBe("cancelled")
    expect(readRuns(filename).find(({ invocation_id }) => invocation_id === "code-mode-proof")?.status).toBe(
      "cancelled",
    )
    expect(toolCalls).toEqual(["read"])
    expect(yield* fixture.requests).toHaveLength(1)
  }),
)

it.live(
  "reconstructs an admitted Code Mode Program exactly after a SQLite restart",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-code-mode-restart-${yield* Random.nextInt}.db`
      const identity = "code-mode-restart-route"
      const fixture = yield* TestModel.make(
        [
          TestModel.turn([codeMode()]),
          TestModel.turn([TestModel.text("Oracle restart result")]),
          TestModel.turn([TestModel.text("root restarted complete")]),
        ],
        { provider: "test", model: "test", registrationKey: identity },
      )
      const toolCalls: Array<string> = []
      const admitted = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(executionLayer(filename, fixture, toolCalls))
          const gateway = Context.get(context, ExecutionGateway.Service)
          const link = yield* gateway.startTurn(input(identity))
          const runs = yield* awaitProgramAdmission(filename)
          return { link, runs }
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, credentialConfigProvider)),
      )
      const admittedProgram = admitted.runs.find(({ invocation_id }) => invocation_id === "code-mode-proof")!
      expect(admittedProgram.status).toBe("running")
      expect(toolCalls).toEqual([])
      expect(yield* fixture.requests).toHaveLength(1)

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(executionLayer(filename, fixture, toolCalls))
          const gateway = Context.get(context, ExecutionGateway.Service)
          const events = yield* gateway.watchTurn(admitted.link).pipe(Stream.runCollect)
          return { events: [...events], status: yield* gateway.inspectTurn(admitted.link) }
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, credentialConfigProvider)),
      )

      const settledRuns = readRuns(filename)
      const settledProgram = settledRuns.find(({ invocation_id }) => invocation_id === "code-mode-proof")!
      expect(settledProgram.run_id).toBe(admittedProgram.run_id)
      expect(settledProgram.parent_run_id).toBe(admitted.link.runId)
      expect(settledProgram.status).toBe("succeeded")
      expect(result.status.status).toBe("completed")
      expect(result.events.at(-1)?.state.status).toBe("completed")
      expect(toolCalls).toEqual(["read"])

      const evidence = persistedRegistrationEvidence(filename)
      expect(evidence.tableNames.some((name) => name.startsWith("rika_"))).toBe(false)
      const settledExecutable = executableOf(settledProgram)
      expect(evidence.programRuns).toEqual([
        expect.objectContaining({
          run_id: settledProgram.run_id,
          program_pin: settledExecutable.ref.active,
          budget_json: budgetJson(programBudget),
        }),
      ])
      const programEntry = settledExecutable.manifest.entries.find(({ pin }) => pin === settledExecutable.ref.active)
      expect(programEntry).toMatchObject({
        _tag: "Program",
        manifest: {
          source: { language: "javascript", text: source },
          capabilities: {
            tools: [{ name: "read" }],
            agents: [{ selection: "Oracle" }],
            steps: [],
          },
          budget: programBudget,
        },
      })
      const linkedPins = new Map<string, Array<string>>()
      for (const link of evidence.links) linkedPins.set(link.run_id, [...(linkedPins.get(link.run_id) ?? []), link.pin])
      for (const run of settledRuns) {
        expect(new Set(linkedPins.get(run.run_id))).toEqual(
          ExecutableRegistration.requiredPinsForActiveExecutable(executableOf(run)),
        )
      }
      const persistedRegistrations = evidence.payloads.map(({ pin, payload_json }) => ({
        pin,
        payload: registrationPayloadJson(payload_json),
      }))
      expect(persistedRegistrations).not.toHaveLength(0)
      const credentialRegistrations = persistedRegistrations.filter(
        ({ payload }) =>
          includesString(payload, "RIKA_CODE_MODE_API_KEY") || includesString(payload, "rika-code-mode-credential"),
      )
      expect(credentialRegistrations).not.toHaveLength(0)
      for (const { payload } of credentialRegistrations) {
        expect(includesString(payload, "RIKA_CODE_MODE_API_KEY")).toBe(true)
        expect(includesString(payload, "rika-code-mode-credential")).toBe(true)
      }
      for (const { payload } of persistedRegistrations) {
        expect(includesString(payload, resolvedCredentialValue)).toBe(false)
      }

      const requests = yield* fixture.requests
      expect(requests).toHaveLength(3)
      const oraclePrompt = promptJson(requests[1]?.prompt)
      const resumedPrompt = promptJson(requests[2]?.prompt)
      expect(oraclePrompt).toContain("inspect the durable proof")
      expect(resumedPrompt.match(/"type":"tool-result"/g)).toHaveLength(1)
      expect(resumedPrompt).toContain("Oracle restart result")
    }),
  30_000,
)
