import { expect, it } from "@effect/vitest"
import { ExecutableManifest } from "@batonfx/core"
import { ChildRuns, ExecutableRegistration } from "@batonfx/runtime"
import * as Settings from "@rika/config/configuration-settings"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import * as JavaScriptSandbox from "@rika/sandbox/javascript-sandbox"
import { Cause, ConfigProvider, Effect, Exit, Schema } from "effect"
import { configure } from "../src/baton-route"

const sandbox = JavaScriptSandbox.make()

const modelCandidates = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

it.effect("resolves complete ordered model candidates deterministically", () =>
  Effect.sync(() => {
    const first = ExecutionRouteResolution.resolve(Settings.Defaults.settingsDefaults, "medium", {
      fastMode: false,
      tokenBudget: 12_000,
    })
    const second = ExecutionRouteResolution.resolve(Settings.Defaults.settingsDefaults, "medium", {
      fastMode: false,
      tokenBudget: 12_000,
    })
    expect(first).toEqual(second)
    expect(first.version).toBe(1)
    expect(first.tokenBudget).toBe(12_000)
    expect(first.main.registrationIdentity).toMatch(/^rika:model:[a-f0-9]{64}$/)
    expect(first.main.candidates).toHaveLength(Settings.Defaults.settingsDefaults.models.luna!.candidates.length)
    expect(first.main.candidates[0]?.providerOptions?.max_output_tokens).toBe(128_000)
    const mainAlias = Settings.Defaults.settingsDefaults.modes.medium.main.alias
    const orderedSettings = {
      ...Settings.Defaults.settingsDefaults,
      models: {
        ...Settings.Defaults.settingsDefaults.models,
        [mainAlias]: {
          ...Settings.Defaults.settingsDefaults.models[mainAlias]!,
          candidates: ["ordered-a", "ordered-b"],
        },
      },
    }
    const reorderedSettings = {
      ...orderedSettings,
      models: {
        ...orderedSettings.models,
        [mainAlias]: {
          ...orderedSettings.models[mainAlias]!,
          candidates: orderedSettings.models[mainAlias]!.candidates.toReversed(),
        },
      },
    }
    const ordered = ExecutionRouteResolution.resolve(orderedSettings, "medium")
    const reordered = ExecutionRouteResolution.resolve(reorderedSettings, "medium")
    expect(reordered.main.candidates.map(({ model }) => model)).toEqual(
      ordered.main.candidates.map(({ model }) => model).toReversed(),
    )
    expect(reordered.main.registrationIdentity).not.toBe(ordered.main.registrationIdentity)
    expect(reordered.main.candidates[0]?.registrationIdentity).not.toBe(
      ordered.main.candidates[0]?.registrationIdentity,
    )
  }),
)

it.effect("builds one exact closed executable with role-specific tool and service pins", () =>
  Effect.gen(function* () {
    const route = testExecutionRoute()
    const executionRoute = {
      ...route,
      compactionSummary: {
        ...route.compactionSummary,
        registrationIdentity: "test-compaction-route" as (typeof route.compactionSummary)["registrationIdentity"],
      },
    }
    const configured = yield* configure({ executionRoute, workspace: "/workspace", sandbox })
    expect(Object.keys(configured.profiles)).toEqual([
      "Title",
      "Oracle",
      "Librarian",
      "Painter",
      "ReadThread",
      "Review",
      "Surgeon",
      "Task",
    ])
    expect(configured.resolverEntries).toHaveLength(9)
    const rootResolution = configured.resolverEntries[0]!
    expect("agent" in rootResolution ? rootResolution.agent.model : undefined).toMatchObject({
      provider: "@batonfx/providers",
      model: "ordered-route",
    })
    expect(configured.executable.manifest.version).toBe("1")
    const rootEntry = configured.executable.manifest.entries.find(({ pin }) => pin === configured.executable.ref.active)
    expect(rootEntry?._tag).toBe("Agent")
    expect(rootEntry?._tag === "Agent" ? rootEntry.manifest.children.map(({ selection }) => selection) : []).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "ReadThread",
      "Review",
      "Surgeon",
      "Task",
      "Title",
    ])
    const rootToolNames = rootEntry?._tag === "Agent" ? rootEntry.manifest.tools.map(({ name }) => name) : []
    expect(
      rootToolNames.filter((name) => ["run_child", "start_child_group", "await_child_group"].includes(name)),
    ).toEqual(["await_child_group", "run_child", "start_child_group"])
    expect(rootToolNames).toContain("read")
    expect(rootToolNames).not.toEqual(expect.arrayContaining(["title", "oracle", "librarian", "task"]))
    expect(configured.profiles.Title!.manifest.tools).toEqual([])
    for (const profile of Object.values(configured.profiles)) {
      expect(profile.manifest.budget.totalTokens).toBe(10_000_000)
      expect(profile.manifest.budget.modelCalls).toBeGreaterThan(0)
    }
    expect(configured.profiles.Librarian!.manifest.tools.map(({ name }) => name)).toEqual([
      "read_web_page",
      "web_search",
    ])
    expect(configured.profiles.Painter!.manifest.tools.map(({ name }) => name)).toEqual(["read", "view_media"])
    expect(configured.profiles.Surgeon!.manifest.tools.map(({ name }) => name)).toEqual([
      "bash",
      "edit",
      "grep",
      "read",
      "shell_command_status",
      "write",
    ])
    expect(configured.profiles.Task!.manifest.children.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "ReadThread",
      "Surgeon",
    ])
    expect(configured.profiles.Task!.manifest.children.map(({ selection }) => selection)).not.toContain("Task")
    expect(
      configured.profiles
        .Task!.manifest.tools.map(({ name }) => name)
        .filter((name) => ["run_child", "start_child_group", "await_child_group"].includes(name)),
    ).toEqual(["await_child_group", "run_child", "start_child_group"])
    const rootAgent = rootResolution.agent
    const taskAgent = configured.resolverEntries.find(({ agent }) => agent.name === "rika-task")!.agent
    const rootRunChild = rootAgent.toolkit.tools.run_child!
    const rootStartGroup = rootAgent.toolkit.tools.start_child_group!
    const taskRunChild = taskAgent.toolkit.tools.run_child!
    expect(
      (yield* Schema.decodeUnknownEffect(rootRunChild.parametersSchema as typeof ChildRuns.Parameters)({
        selection: "Review",
        prompt: "review",
      })).selection,
    ).toBe("Review")
    expect(() =>
      Schema.decodeUnknownSync(rootRunChild.parametersSchema as typeof ChildRuns.Parameters)({
        selection: "Unknown",
        prompt: "unknown",
      }),
    ).toThrow()
    expect(
      (yield* Schema.decodeUnknownEffect(rootStartGroup.parametersSchema as typeof ChildRuns.StartGroupParameters)({
        concurrency: 2,
        members: [
          { key: "first", selection: "Task", prompt: "first" },
          { key: "second", selection: "Oracle", prompt: "second" },
        ],
      })).members.map(({ selection }) => selection),
    ).toEqual(["Task", "Oracle"])
    expect(
      (yield* Schema.decodeUnknownEffect(taskRunChild.parametersSchema as typeof ChildRuns.Parameters)({
        selection: "Surgeon",
        prompt: "fix",
      })).selection,
    ).toBe("Surgeon")
    expect(() =>
      Schema.decodeUnknownSync(taskRunChild.parametersSchema as typeof ChildRuns.Parameters)({
        selection: "Task",
        prompt: "recurse",
      }),
    ).toThrow()
    expect(rootEntry?._tag === "Agent" ? rootEntry.manifest.toolScheduling : undefined).toEqual({
      maxConcurrency: 4,
      parallelSafe: [
        "grep",
        "read",
        "read_thread_transcript",
        "read_web_page",
        "search_threads",
        "view_media",
        "web_search",
      ],
    })
    expect(configured.profiles.Task!.manifest.toolScheduling).toEqual({
      maxConcurrency: 4,
      parallelSafe: ["grep", "read", "read_web_page", "view_media", "web_search"],
    })
    expect(configured.profiles.Surgeon!.manifest.toolScheduling).toEqual({
      maxConcurrency: 4,
      parallelSafe: ["grep", "read"],
    })
    const expectedParallelSafe = new Set([
      "grep",
      "read",
      "web_search",
      "read_web_page",
      "view_media",
      "search_threads",
      "read_thread_transcript",
      "find_thread",
    ])
    for (const entry of configured.executable.manifest.entries) {
      if (entry._tag !== "Agent") continue
      expect(entry.manifest.toolScheduling).toEqual({
        maxConcurrency: 4,
        parallelSafe: entry.manifest.tools
          .map(({ name }) => name)
          .filter((name) => expectedParallelSafe.has(name))
          .toSorted(),
      })
      expect(entry.manifest.toolScheduling.parallelSafe).not.toEqual(
        expect.arrayContaining([
          "write",
          "edit",
          "bash",
          "shell_command_status",
          "run_child",
          "start_child_group",
          "await_child_group",
        ]),
      )
    }
    expect(rootEntry?._tag === "Agent" ? rootEntry.manifest.compaction : undefined).toMatchObject({
      contextWindow: executionRoute.main.compaction.contextWindow,
      keepRecentTokens: executionRoute.main.compaction.keepRecentTokens,
      reserveTokens: executionRoute.main.compaction.reserveTokens,
      strategyIdentity: executionRoute.compaction.strategy,
      summaryModel: configured.registrations.find(
        ({ codec, payload }) =>
          codec === "rika-model-route" && (payload as { readonly role?: string }).role === "compaction",
      )?.pin,
      summaryPromptIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect("runOptions" in rootResolution ? rootResolution.runOptions?.compaction : undefined).toEqual({
      contextWindow: executionRoute.main.compaction.contextWindow,
      reserveTokens: executionRoute.main.compaction.reserveTokens,
    })
    expect(configured.registrations.find((registration) => registration.codec === "rika-compaction")?.payload).toEqual({
      keepRecentTokens: executionRoute.main.compaction.keepRecentTokens,
      strategyIdentity: "default",
      summaryPromptIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(() =>
      ExecutableManifest.validateRef(configured.executable.ref, configured.executable.manifest),
    ).not.toThrow()
    expect(configured.registrations.every(({ payload }) => JSON.stringify(payload).includes("secret") === false)).toBe(
      true,
    )
    expect(
      configured.registrations.every(
        (registration) => new TextEncoder().encode(JSON.stringify(registration)).byteLength <= 65_536,
      ),
    ).toBe(true)
    const registrationPins = new Set(configured.registrations.map(({ pin }) => pin))
    expect(registrationPins).toEqual(ExecutableRegistration.requiredPins(configured.executable))
    yield* ExecutableRegistration.validate(configured.executable, configured.registrations)
    for (const name of ["run_child", "start_child_group", "await_child_group"]) {
      expect(
        configured.registrations.some(
          ({ codec, payload }) => codec === "rika-tool" && (payload as { readonly name?: string }).name === name,
        ),
      ).toBe(true)
    }
    for (const entry of configured.executable.manifest.entries) {
      if (entry._tag !== "Agent") continue
      expect(registrationPins.has(entry.manifest.model)).toBe(true)
      for (const capability of [...entry.manifest.tools, ...entry.manifest.services]) {
        expect(registrationPins.has(capability.pin)).toBe(true)
      }
      if (entry.manifest.compaction !== undefined) {
        expect(registrationPins.has(entry.manifest.compaction.service)).toBe(true)
        expect(registrationPins.has(entry.manifest.compaction.summaryModel)).toBe(true)
      }
    }
  }),
)

it.effect("delegates persisted provider-option decoding to Baton", () =>
  Effect.gen(function* () {
    const route = testExecutionRoute()
    const candidate = {
      ...route.main.candidates[0]!,
      model: "bedrock-test",
      registrationIdentity: "bedrock-registration" as (typeof route.main.candidates)[number]["registrationIdentity"],
      providerConnection: {
        provider: "amazon-bedrock",
        protocol: "amazon-bedrock" as const,
        baseUrl: "bedrock://default?authMode=default",
        authentication: "none" as const,
      },
      providerOptions: {
        maxTokens: 4_096,
        additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 2_048 } },
      },
    }
    const executionRoute = { ...route, main: { ...route.main, candidates: [candidate] } }
    const configured = yield* configure({ executionRoute, workspace: "/workspace", sandbox })
    const root = configured.resolverEntries[0]!
    const selection = "agent" in root ? root.agent.model : undefined
    expect(modelCandidates(selection?.registrationKey ?? "[]")).toEqual([
      ["amazon-bedrock", "bedrock-test", "bedrock-registration"],
    ])

    const invalid = yield* configure({
      executionRoute: {
        ...executionRoute,
        main: { ...executionRoute.main, candidates: [{ ...candidate, providerOptions: { max_tokens: 4_096 } }] },
      },
      workspace: "/workspace",
      sandbox,
    }).pipe(Effect.exit)
    expect(Exit.isFailure(invalid)).toBe(true)
    if (Exit.isFailure(invalid)) expect(Cause.pretty(invalid.cause)).toContain("max_tokens")
  }),
)

it.effect("changes executable identity for candidate order and workspace", () =>
  Effect.gen(function* () {
    const first = testExecutionRoute("first")
    const secondCandidate = {
      ...first.main.candidates[0]!,
      model: "test-fallback",
      registrationIdentity: "test-fallback" as (typeof first.main.candidates)[number]["registrationIdentity"],
    }
    const ordered = { ...first, main: { ...first.main, candidates: [first.main.candidates[0]!, secondCandidate] } }
    const reversed = { ...ordered, main: { ...ordered.main, candidates: ordered.main.candidates.toReversed() } }
    const orderedExecutable = yield* configure({ executionRoute: ordered, workspace: "/one", sandbox })
    const reversedExecutable = yield* configure({ executionRoute: reversed, workspace: "/one", sandbox })
    const otherWorkspace = yield* configure({ executionRoute: ordered, workspace: "/two", sandbox })
    const orderedRoot = orderedExecutable.resolverEntries[0]!
    const orderedSelection = "agent" in orderedRoot ? orderedRoot.agent.model : undefined
    expect(modelCandidates(orderedSelection?.registrationKey ?? "[]")).toEqual([
      ["test", "test", "test"],
      ["test", "test-fallback", "test-fallback"],
    ])
    expect(orderedExecutable.executable.ref).not.toEqual(reversedExecutable.executable.ref)
    expect(orderedExecutable.executable.ref).not.toEqual(otherWorkspace.executable.ref)
  }),
)

it.effect("pins the product token budget into every Agent manifest", () =>
  Effect.gen(function* () {
    const executable = yield* configure({
      executionRoute: { ...testExecutionRoute(), tokenBudget: 12_000 },
      workspace: "/workspace",
      sandbox,
    })
    expect(
      executable.executable.manifest.entries.every(
        (entry) => entry._tag !== "Agent" || entry.manifest.budget.totalTokens === 12_000,
      ),
    ).toBe(true)
  }),
)

it.effect("resolves an openai candidate through its configured api key environment variable", () =>
  Effect.gen(function* () {
    const route = testExecutionRoute()
    const candidate = {
      ...route.main.candidates[0]!,
      model: "gpt-5.6-sol",
      providerConnection: {
        provider: "openai",
        protocol: "openai",
        baseUrl: "https://switchboard.example/v1",
        authentication: "api-key" as const,
        apiKeyEnvironment: "SWITCHBOARD_API_KEY",
      },
      registrationIdentity:
        "switchboard-registration" as (typeof route.main.candidates)[number]["registrationIdentity"],
      providerOptions: { max_output_tokens: 4_096 },
    }
    const executionRoute = { ...route, main: { ...route.main, candidates: [candidate] } }
    const configured = yield* configure({ executionRoute, workspace: "/workspace", sandbox }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { SWITCHBOARD_API_KEY: "switchboard-secret" } }),
      ),
    )
    const root = configured.resolverEntries[0]!
    const selection = "agent" in root ? root.agent.model : undefined
    expect(modelCandidates(selection?.registrationKey ?? "[]")).toEqual([
      ["openai", "gpt-5.6-sol", "switchboard-registration"],
    ])
  }),
)

it.effect("reports the missing api key environment variable by name instead of a redacted registry failure", () =>
  Effect.gen(function* () {
    const route = testExecutionRoute()
    const candidate = {
      ...route.main.candidates[0]!,
      model: "gpt-5.6-sol",
      providerConnection: {
        provider: "openai",
        protocol: "openai",
        baseUrl: "https://switchboard.example/v1",
        authentication: "api-key" as const,
        apiKeyEnvironment: "SWITCHBOARD_API_KEY",
      },
      registrationIdentity:
        "switchboard-registration" as (typeof route.main.candidates)[number]["registrationIdentity"],
      providerOptions: { max_output_tokens: 4_096 },
    }
    const executionRoute = { ...route, main: { ...route.main, candidates: [candidate] } }
    const failed = yield* configure({ executionRoute, workspace: "/workspace", sandbox }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
      Effect.exit,
    )
    expect(Exit.isFailure(failed)).toBe(true)
    const pretty = Exit.isFailure(failed) ? Cause.pretty(failed.cause) : ""
    expect(pretty).toContain("SWITCHBOARD_API_KEY")
    expect(pretty).not.toContain("Unable to get redacted value")
  }),
)

type RouteModel = ReturnType<typeof testExecutionRoute>["main"]

const distinct = (model: RouteModel, identity: string): RouteModel => ({
  ...model,
  registrationIdentity: identity as RouteModel["registrationIdentity"],
  candidates: model.candidates.map((candidate) => ({
    ...candidate,
    registrationIdentity: identity as (typeof candidate)["registrationIdentity"],
  })),
})

const registryPayloads = (registrations: ReadonlyArray<ExecutableRegistration.ExecutableRegistration>) =>
  new Map(
    registrations
      .filter(({ codec }) => codec === "rika-model-registry-route")
      .map(({ pin, payload }) => [pin, JSON.stringify(payload)] as const),
  )

it.effect("registers one stable payload per model registry pin regardless of which role uses the route", () =>
  Effect.gen(function* () {
    const base = testExecutionRoute()
    const spread = (shared: "oracle" | "surgeon") => ({
      ...base,
      title: distinct(base.title, "identity-title"),
      compactionSummary: distinct(base.compactionSummary, "identity-compaction"),
      main: distinct(base.main, "identity-main"),
      oracle: distinct(base.oracle, shared === "oracle" ? "identity-shared" : "identity-oracle"),
      agents: {
        librarian: distinct(base.agents.librarian, "identity-librarian"),
        painter: distinct(base.agents.painter, "identity-painter"),
        readThread: distinct(base.agents.readThread, "identity-read-thread"),
        review: distinct(base.agents.review, "identity-review"),
        surgeon: distinct(base.agents.surgeon, shared === "surgeon" ? "identity-shared" : "identity-surgeon"),
        task: distinct(base.agents.task, "identity-task"),
      },
    })
    const asOracle = yield* configure({ executionRoute: spread("oracle"), workspace: "/workspace", sandbox })
    const asSurgeon = yield* configure({ executionRoute: spread("surgeon"), workspace: "/workspace", sandbox })
    const first = registryPayloads(asOracle.registrations)
    const second = registryPayloads(asSurgeon.registrations)
    const shared = [...first.keys()].filter((pin) => second.has(pin))
    expect(shared.length).toBeGreaterThan(0)
    for (const pin of shared) expect([pin, second.get(pin)]).toEqual([pin, first.get(pin)])
    yield* ExecutableRegistration.validate(asOracle.executable, asOracle.registrations)
    yield* ExecutableRegistration.validate(asSurgeon.executable, asSurgeon.registrations)
  }),
)
