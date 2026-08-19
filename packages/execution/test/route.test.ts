import { expect, it } from "@effect/vitest"
import { ExecutableManifest } from "tenetkit"
import { HarnessState } from "tenetkit/harness"
import { CellTool } from "tenetkit/repl"
import { ExecutableRegistration } from "tenetkit/runtime"
import * as Settings from "@rika/configuration/configuration-settings"
import * as KernelProfileRegistration from "@rika/kernel/kernel-profile-registration"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Cause, ConfigProvider, Effect, Exit, Schema } from "effect"
import * as Registration from "../src/registration"
import { profileInstructions } from "../src/route"
import { configure } from "./test-adapters"

const kernel = { runtimeVersion: "1.3.14", dataRoot: "/data" } as const

const conversationalProfiles = ["Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon", "Task"] as const

type Configured = Effect.Success<ReturnType<typeof configure>>

const agentEntries = (configured: Configured) =>
  [...configured.executable.manifest.entries, ...configured.titleExecutable.manifest.entries].flatMap((entry) =>
    entry._tag === "Agent" ? [entry] : [],
  )

const profileNameOf = (entry: ReturnType<typeof agentEntries>[number]) => entry.manifest.name.replace("rika-", "")

const modelCandidates = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

/**
 * Values a host holds as credentials. A registration that carried any of these would leak it into
 * durable state, so the assertion names the real values rather than a word they happen to contain:
 * a key like `sk-proj-0a1b2c3d` contains no such word and would pass an unconstrained search.
 */
const credentialValues = ["switchboard-secret", "sk-proj-0a1b2c3d4e5f", "ghp_0123456789abcdef", "hunter2"] as const

const encodeRegistrations = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

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
    expect(first.version).toBe(3)
    expect(first.subagents).toEqual({ maxDepth: 1, maxSubagents: 4 })
    expect(first.tokenBudget).toBe(12_000)
    expect(first.main.registrationIdentity).toMatch(/^rika:model:v1:[a-f0-9]{64}$/)
    expect(first.main.candidates).toHaveLength(Settings.Defaults.settingsDefaults.models.luna!.candidates.length)
    expect(first.main.candidates[0]?.providerOptions?.max_output_tokens).toBe(128_000)
    const mainAlias = "luna"
    const orderedSettings = {
      ...Settings.Defaults.settingsDefaults,
      models: {
        ...Settings.Defaults.settingsDefaults.models,
        [mainAlias]: {
          ...Settings.Defaults.settingsDefaults.models[mainAlias]!,
          candidates: ["ordered-a", "ordered-b"],
        },
      },
      modes: {
        ...Settings.Defaults.settingsDefaults.modes,
        medium: {
          ...Settings.Defaults.settingsDefaults.modes.medium!,
          main: { alias: mainAlias, effort: "medium" as const },
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

it.effect("builds exact closed root and title executables with role-specific tool and service pins", () =>
  Effect.gen(function* () {
    const route = testExecutionRoute()
    const executionRoute = {
      ...route,
      compactionSummary: {
        ...route.compactionSummary,
        registrationIdentity: "test-compaction-route" as (typeof route.compactionSummary)["registrationIdentity"],
      },
    }
    const configured = yield* configure({ executionRoute, workspace: "/workspace", kernel })
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
      provider: "tenetkit/ai",
      model: "ordered-route",
    })
    expect(configured.executable.manifest.version).toBe("2")
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
    ])
    const rootToolNames = rootEntry?._tag === "Agent" ? rootEntry.manifest.tools.map(({ name }) => name) : []
    expect(rootToolNames).toEqual([CellTool.name])
    expect(configured.profiles.Title!.manifest.tools).toEqual([])
    for (const profile of Object.values(configured.profiles)) {
      expect(profile.manifest.budget).toEqual({})
    }
    for (const name of conversationalProfiles) {
      expect(configured.profiles[name]!.manifest.tools.map(({ name: toolName }) => toolName)).toEqual([CellTool.name])
    }
    expect(configured.profiles.Task!.manifest.children.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "ReadThread",
      "Review",
      "Surgeon",
      "Task",
    ])
    for (const entry of agentEntries(configured)) {
      const names = entry.manifest.tools.map(({ name }) => name)
      expect(names).toEqual(profileNameOf(entry) === "title" ? [] : [CellTool.name])
      expect(entry.manifest.toolScheduling).toEqual({ maxConcurrency: 1, parallelSafe: [] })
    }
    expect(configured.executable.manifest.profiles.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "ReadThread",
      "Review",
      "Surgeon",
      "Task",
    ])
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
    const encodedRegistrations = encodeRegistrations([...configured.registrations, ...configured.titleRegistrations])
    for (const credential of credentialValues) expect(encodedRegistrations).not.toContain(credential)

    expect(
      configured.registrations.every(
        (registration) => new TextEncoder().encode(JSON.stringify(registration)).byteLength <= 65_536,
      ),
    ).toBe(true)
    const registrationPins = new Set(configured.registrations.map(({ pin }) => pin))
    expect(registrationPins).toEqual(ExecutableRegistration.requiredPins(configured.executable))
    yield* ExecutableRegistration.validate(configured.executable, configured.registrations)
    expect(new Set(configured.titleRegistrations.map(({ pin }) => pin))).toEqual(
      ExecutableRegistration.requiredPins(configured.titleExecutable),
    )
    yield* ExecutableRegistration.validate(configured.titleExecutable, configured.titleRegistrations)
    expect(
      configured.registrations
        .filter(({ codec }) => codec === "rika-tool")
        .map(({ payload }) => (payload as { readonly name: string }).name),
    ).toContain(CellTool.name)
    const advertised = new Set(
      agentEntries(configured).flatMap((entry) => entry.manifest.tools.map(({ name }) => name)),
    )
    expect([...advertised]).toEqual([CellTool.name])
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

it.effect("delegates persisted provider-option decoding to TenetKit", () =>
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
    const configured = yield* configure({ executionRoute, workspace: "/workspace", kernel })
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
      kernel,
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
    const orderedExecutable = yield* configure({ executionRoute: ordered, workspace: "/one", kernel })
    const reversedExecutable = yield* configure({ executionRoute: reversed, workspace: "/one", kernel })
    const otherWorkspace = yield* configure({ executionRoute: ordered, workspace: "/two", kernel })
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

it.effect("never pins a routed token budget into an Agent manifest", () =>
  Effect.gen(function* () {
    const executable = yield* configure({
      executionRoute: { ...testExecutionRoute(), tokenBudget: 12_000 },
      workspace: "/workspace",
      kernel,
    })
    expect(
      executable.executable.manifest.entries.every(
        (entry) => entry._tag !== "Agent" || entry.manifest.budget.totalTokens === undefined,
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
        protocol: "openai-responses",
        baseUrl: "https://switchboard.example/v1",
        authentication: "api-key" as const,
        apiKeyEnvironment: "SWITCHBOARD_API_KEY",
      },
      registrationIdentity:
        "switchboard-registration" as (typeof route.main.candidates)[number]["registrationIdentity"],
      providerOptions: { max_output_tokens: 4_096 },
    }
    const executionRoute = { ...route, main: { ...route.main, candidates: [candidate] } }
    const configured = yield* configure({ executionRoute, workspace: "/workspace", kernel }).pipe(
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
    const encoded = encodeRegistrations(configured.registrations)
    for (const credential of credentialValues) expect(encoded).not.toContain(credential)
  }),
)

it.effect("routes an OpenAI Chat Completions candidate through the released compatible adapter", () =>
  Effect.gen(function* () {
    const route = testExecutionRoute()
    const candidate = {
      ...route.main.candidates[0]!,
      model: "custom-chat-model",
      providerConnection: {
        provider: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://chat-compatible.example/openai/v1",
        authentication: "api-key" as const,
        apiKeyEnvironment: "CHAT_COMPATIBLE_API_KEY",
      },
      registrationIdentity:
        "chat-compatible-registration" as (typeof route.main.candidates)[number]["registrationIdentity"],
      providerOptions: { max_tokens: 4_096 },
    }
    const executionRoute = { ...route, main: { ...route.main, candidates: [candidate] } }
    const configured = yield* configure({ executionRoute, workspace: "/workspace", kernel }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { CHAT_COMPATIBLE_API_KEY: "switchboard-secret" } }),
      ),
    )
    const root = configured.resolverEntries[0]!
    const selection = "agent" in root ? root.agent.model : undefined
    expect(modelCandidates(selection?.registrationKey ?? "[]")).toEqual([
      ["openai", "custom-chat-model", "chat-compatible-registration"],
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
        protocol: "openai-responses",
        baseUrl: "https://switchboard.example/v1",
        authentication: "api-key" as const,
        apiKeyEnvironment: "SWITCHBOARD_API_KEY",
      },
      registrationIdentity:
        "switchboard-registration" as (typeof route.main.candidates)[number]["registrationIdentity"],
      providerOptions: { max_output_tokens: 4_096 },
    }
    const executionRoute = { ...route, main: { ...route.main, candidates: [candidate] } }
    const failed = yield* configure({ executionRoute, workspace: "/workspace", kernel }).pipe(
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
    const asOracle = yield* configure({ executionRoute: spread("oracle"), workspace: "/workspace", kernel })
    const asSurgeon = yield* configure({ executionRoute: spread("surgeon"), workspace: "/workspace", kernel })
    const first = registryPayloads(asOracle.registrations)
    const second = registryPayloads(asSurgeon.registrations)
    const shared = [...first.keys()].filter((pin) => second.has(pin))
    expect(shared.length).toBeGreaterThan(0)
    for (const pin of shared) expect([pin, second.get(pin)]).toEqual([pin, first.get(pin)])
    yield* ExecutableRegistration.validate(asOracle.executable, asOracle.registrations)
    yield* ExecutableRegistration.validate(asSurgeon.executable, asSurgeon.registrations)
  }),
)

it.effect("pins child authority without duplicating TenetKit-owned tools in host manifests", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
    })
    const entries = agentEntries(configured)
    expect([...new Set(entries.map(profileNameOf))].toSorted()).toEqual([
      "librarian",
      "oracle",
      "painter",
      "readthread",
      "review",
      "root",
      "surgeon",
      "task",
      "title",
    ])
    for (const entry of entries) {
      const tools = entry.manifest.tools.map(({ name }) => name)
      if (profileNameOf(entry) === "title") expect(tools).toEqual([])
      else expect(tools).toEqual([CellTool.name])
    }
    expect(configured.executable.manifest.profiles).toHaveLength(conversationalProfiles.length)
  }),
)

it.effect("schedules the cell as an exclusive barrier that is never parallel safe", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
    })
    for (const entry of agentEntries(configured)) {
      expect(entry.manifest.toolScheduling.maxConcurrency).toBe(1)
      expect(entry.manifest.toolScheduling.parallelSafe).toEqual([])
    }
  }),
)

it.effect("pins the kernel profile the host builds its pool from into every conversational profile", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
    })
    const expected = KernelProfileRegistration.pin(
      KernelProfileRegistration.make({
        runtimeVersion: kernel.runtimeVersion,
        workspace: "/workspace",
        dataRoot: kernel.dataRoot,
      }),
    )
    expect(KernelProfileRegistration.digest(configured.kernelProfile)).toBe(
      KernelProfileRegistration.digest(
        KernelProfileRegistration.make({
          runtimeVersion: kernel.runtimeVersion,
          workspace: "/workspace",
          dataRoot: kernel.dataRoot,
        }),
      ),
    )
    for (const entry of agentEntries(configured)) {
      const pinned = entry.manifest.services.find(({ name }) => name === "rika-kernel-profile")
      if (profileNameOf(entry) === "title") {
        expect(pinned).toBeUndefined()
        continue
      }
      expect(pinned?.pin).toBe(expected)
    }
    const registration = configured.registrations.find(({ pin }) => pin === expected)
    expect(registration?.codec).toBe("rika-kernel-profile")
    expect(registration?.payload).toMatchObject({
      workspace: { root: "/workspace", dataRoot: kernel.dataRoot },
      runtime: { name: "bun", version: kernel.runtimeVersion },
      trustMode: "trusted-local",
    })
  }),
)

it.effect("round-trips the pinned kernel profile registration back to the exact profile", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
    })
    const decoded = yield* Registration.read(Registration.codecs.kernelProfile, configured.registrations)
    expect(decoded).toEqual(configured.kernelProfile)
    expect(KernelProfileRegistration.pin(decoded)).toBe(KernelProfileRegistration.pin(configured.kernelProfile))
  }),
)

it.effect("changes the admitted executable when any kernel profile input changes", () =>
  Effect.gen(function* () {
    const base = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
    })
    const changed = yield* Effect.forEach(
      [
        { ...kernel, runtimeVersion: "9.9.9" },
        { ...kernel, dataRoot: "/other-data" },
        { ...kernel, trustMode: "trusted-workspace" as const },
        { ...kernel, limits: { sourceBytes: 1_024, channelBytes: 2_048, cellDeadlineMillis: 5_000 } },
      ],
      (variant) => configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", kernel: variant }),
    )
    for (const variant of changed) {
      expect(KernelProfileRegistration.digest(variant.kernelProfile)).not.toBe(
        KernelProfileRegistration.digest(base.kernelProfile),
      )
      expect(variant.executable.ref.active).not.toBe(base.executable.ref.active)
    }
    const otherWorkspace = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/elsewhere",
      kernel,
    })
    expect(KernelProfileRegistration.digest(otherWorkspace.kernelProfile)).not.toBe(
      KernelProfileRegistration.digest(base.kernelProfile),
    )
  }),
)

it.effect("rejects a registration whose kernel profile payload no longer matches its pin", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
    })
    const tampered = configured.registrations.map((registration) =>
      registration.codec === "rika-kernel-profile"
        ? {
            ...registration,
            payload: {
              ...(registration.payload as Record<string, unknown>),
              trustMode: "trusted-workspace",
            },
          }
        : registration,
    )
    const failure = yield* Effect.exit(
      Registration.verify({
        expected: configured.registrations,
        actual: tampered,
        required: ExecutableRegistration.requiredPins(configured.executable),
      }),
    )
    expect(Exit.isFailure(failure)).toBe(true)
    if (Exit.isFailure(failure)) expect(Cause.pretty(failure.cause)).toContain("registration payload changed")
  }),
)

it.effect("keeps parent-relative child selection authority pinned after the cell swap", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
    })
    const rootEntry = configured.executable.manifest.entries.find(({ pin }) => pin === configured.executable.ref.active)
    expect(rootEntry?._tag === "Agent" ? rootEntry.manifest.children.map(({ selection }) => selection) : []).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "ReadThread",
      "Review",
      "Surgeon",
      "Task",
    ])
    expect(configured.profiles.Task!.manifest.children.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "ReadThread",
      "Review",
      "Surgeon",
      "Task",
    ])
    for (const name of ["Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon"] as const) {
      expect(configured.profiles[name]!.manifest.children.map(({ selection }) => selection)).toEqual([
        "Librarian",
        "Oracle",
        "Painter",
        "ReadThread",
        "Review",
        "Surgeon",
        "Task",
      ])
    }
    for (const entry of agentEntries(configured)) {
      if (profileNameOf(entry) === "title") continue
      expect(entry.manifest.children).toEqual(
        configured.executable.manifest.profiles.map(({ selection }) => ({ selection })),
      )
    }
    for (const profile of configured.executable.manifest.profiles) {
      expect(configured.executable.manifest.entries.some(({ pin }) => pin === profile.agent)).toBe(true)
    }
  }),
)

it.effect("keeps one finite recursive profile registry for every configured depth", () =>
  Effect.gen(function* () {
    for (const maxDepth of [0, 1, 2, 1_024]) {
      const configured = yield* configure({
        executionRoute: { ...testExecutionRoute(), subagents: { maxDepth, maxSubagents: 3 } },
        workspace: "/workspace",
        kernel,
      })
      const root = agentEntries(configured).find(({ pin }) => pin === configured.executable.ref.active)!
      expect(root.manifest.children).toHaveLength(conversationalProfiles.length)
      expect(root.manifest.budget.childRuns).toBeUndefined()
      expect(root.manifest.budget.depth).toBeUndefined()
      expect(configured.profiles.Task!.manifest.children).toEqual(root.manifest.children)
      expect(configured.executable.manifest.profiles).toHaveLength(conversationalProfiles.length)
      expect(configured.executable.manifest.entries).toHaveLength(1 + conversationalProfiles.length)
      expect(configured.resolverEntries).toHaveLength(2 + conversationalProfiles.length)
      expect(() =>
        ExecutableManifest.validateRef(configured.executable.ref, configured.executable.manifest),
      ).not.toThrow()
    }
  }),
)

it.effect("leaves active-capacity gating to the pinned runtime tree policy", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: { ...testExecutionRoute(), subagents: { maxDepth: 4, maxSubagents: 0 } },
      workspace: "/workspace",
      kernel,
    })
    const root = agentEntries(configured).find(({ pin }) => pin === configured.executable.ref.active)!
    expect(root.manifest.children).toHaveLength(conversationalProfiles.length)
    expect(root.manifest.tools.map(({ name }) => name)).toEqual([CellTool.name])
    expect(root.manifest.budget.childRuns).toBeUndefined()
    expect(configured.executable.manifest.entries).toHaveLength(1 + conversationalProfiles.length)
    expect(configured.resolverEntries).toHaveLength(2 + conversationalProfiles.length)
  }),
)

it.effect("pins discovered skills into every conversational profile and registers each one", () =>
  Effect.gen(function* () {
    const skills = [
      { name: "writing-rika-tests", digest: "digest-tests" },
      { name: "debugging-rika", digest: "digest-debug", importName: "debugging_rika" },
    ]
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      skills,
    })
    for (const entry of agentEntries(configured)) {
      const names = entry.manifest.skills.map(({ name }) => name)
      expect(names).toEqual(profileNameOf(entry) === "title" ? [] : ["debugging-rika", "writing-rika-tests"])
    }
    const registrationPins = new Set(configured.registrations.map(({ pin }) => pin))
    for (const capability of configured.profiles.Task!.manifest.skills) {
      expect(registrationPins.has(capability.pin)).toBe(true)
    }
    expect(registrationPins).toEqual(ExecutableRegistration.requiredPins(configured.executable))
    yield* ExecutableRegistration.validate(configured.executable, configured.registrations)
    expect(new Set(configured.titleRegistrations.map(({ pin }) => pin))).toEqual(
      ExecutableRegistration.requiredPins(configured.titleExecutable),
    )
    yield* ExecutableRegistration.validate(configured.titleExecutable, configured.titleRegistrations)
  }),
)

it.effect("changes the admitted executable when a pinned skill digest changes", () =>
  Effect.gen(function* () {
    const base = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      skills: [{ name: "writing-rika-tests", digest: "digest-one" }],
    })
    const changed = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      skills: [{ name: "writing-rika-tests", digest: "digest-two" }],
    })
    expect(changed.executable.ref.active).not.toBe(base.executable.ref.active)
  }),
)

it.effect("keeps the admitted executable stable when skill discovery order churns", () =>
  Effect.gen(function* () {
    const skills = [
      { name: "alpha", digest: "digest-alpha" },
      { name: "beta", digest: "digest-beta" },
    ]
    const forward = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      skills,
    })
    const reversed = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      skills: skills.toReversed(),
    })
    expect(reversed.executable.ref.active).toBe(forward.executable.ref.active)
  }),
)

it.effect("carries a harness refinement into the instructions the root agent is given", () =>
  Effect.gen(function* () {
    const executionRoute = testExecutionRoute()
    const empty = HarnessState.empty("global")
    const harnessSnapshot = {
      ...empty,
      entries: {
        ...empty.entries,
        memory: [
          {
            id: "carried",
            kind: "memory" as const,
            scope: "global",
            title: "Carried memory",
            content: "PROOF_OF_A_CARRIED_REFINEMENT",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
          },
        ],
      },
    }
    const configured = yield* configure({ executionRoute, workspace: "/workspace", kernel, harnessSnapshot })
    const root = configured.resolverEntries[0]!
    const rootSupplemental = "agent" in root ? root.agent.open((agent) => agent.supplemental ?? "") : ""
    expect(rootSupplemental).toContain("PROOF_OF_A_CARRIED_REFINEMENT")
    const conversational = configured.resolverEntries.filter(
      (entry) => "agent" in entry && entry.agent.name !== "rika-title",
    )
    expect(conversational).toHaveLength(8)
    expect(
      conversational.every((entry) =>
        entry.agent.open((agent) => (agent.supplemental ?? "").includes("PROOF_OF_A_CARRIED_REFINEMENT")),
      ),
    ).toBe(true)
    expect(conversational.filter((entry) => entry.agent.name === "rika-task")).toHaveLength(1)
  }),
)

it("documents flat child groups and refuses local work delegated to web-only Librarians", () => {
  for (const prompt of [profileInstructions.root, profileInstructions.Task]) {
    expect(prompt).toContain("Before spawning a child")
    expect(prompt).toContain("Librarian is web-only")
    expect(prompt).toContain("Refuse a mismatched Librarian spawn")
    expect(prompt).toContain("select Task or Oracle")
    expect(prompt).toContain("{ members: [{ key, selection, label?, prompt }], concurrency }")
    expect(prompt).toContain("run_child_group")
    expect(prompt).toContain("resume this same Run")
    expect(prompt).toContain("never JSON-stringify it or nest it under another members field")
  }
  expect(profileInstructions.Task).toContain("delegate recursively")
  expect(profileInstructions.Task).toContain("pinned tree policy")
  expect(profileInstructions.Librarian).toContain("Your tools are web-only")
  expect(profileInstructions.Librarian).toContain("refuse and tell the parent")
  expect(profileInstructions.Librarian).toContain("local-capable Task or Oracle child")
})

const budgetDimensions = ["modelCalls", "toolCalls", "totalTokens", "childRuns", "handoffs", "depth", "deadline"]

it.effect(
  "resolves every live agent with an unlimited budget so the execution host can never substitute a ceiling",
  () =>
    configure({
      executionRoute: { ...testExecutionRoute(), tokenBudget: 12_000 },
      workspace: "/workspace",
      kernel,
    }).pipe(
      Effect.map((configured) => {
        expect(configured.resolverEntries.length).toBeGreaterThan(0)
        for (const resolution of configured.resolverEntries) {
          if (!("agent" in resolution)) continue
          const budget = resolution.agent.budget
          expect(budget, `${resolution.agent.name} must carry an explicit budget the host cannot default`).toBeDefined()
          for (const dimension of budgetDimensions)
            expect(
              (budget as Record<string, unknown>)[dimension],
              `${resolution.agent.name} must not cap ${dimension}`,
            ).toBeUndefined()
        }
      }),
    ),
)

it.effect(
  "pins every agent with the same unlimited budget it resolves, so the attested pin matches the executed run",
  () =>
    configure({
      executionRoute: { ...testExecutionRoute(), tokenBudget: 12_000 },
      workspace: "/workspace",
      kernel,
    }).pipe(
      Effect.map((configured) => {
        const entries = agentEntries(configured)
        expect(entries.length).toBeGreaterThan(0)
        for (const entry of entries) {
          expect(entry.manifest.budget, `${profileNameOf(entry)} must pin an empty budget`).toEqual({})
          for (const dimension of budgetDimensions)
            expect(
              (entry.manifest.budget as Record<string, unknown>)[dimension],
              `${profileNameOf(entry)} must not cap ${dimension}`,
            ).toBeUndefined()
        }
      }),
    ),
)

it.effect("pins every agent with an unbounded turn policy so no framework turn cap can stop a run", () =>
  configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", kernel }).pipe(
    Effect.map((configured) => {
      for (const entry of agentEntries(configured)) {
        expect(entry.manifest.policy._tag, `${profileNameOf(entry)} must pin a portable policy`).toBe("Portable")
        if (entry.manifest.policy._tag !== "Portable") continue
        expect(entry.manifest.policy.policy, `${profileNameOf(entry)} must run forever`).toEqual({ _tag: "Forever" })
      }
    }),
  ),
)

it.effect("keeps subagent depth and fan-out as the only pinned execution limits", () =>
  configure({ executionRoute: testExecutionRoute(), workspace: "/workspace", kernel }).pipe(
    Effect.map(() => {
      expect(testExecutionRoute().subagents).toEqual({ maxDepth: 1, maxSubagents: 4 })
    }),
  ),
)

it.effect("registers the harness pin the resolver expects for the same workspace and refuses one from another", () =>
  Effect.gen(function* () {
    const executionRoute = testExecutionRoute()
    const empty = HarnessState.empty("global")
    const snapshotFor = (scope: string) => ({ ...empty, scope })
    const one = yield* configure({
      executionRoute,
      workspace: "/one",
      kernel,
      harnessSnapshot: snapshotFor("workspace:one"),
    })
    const another = yield* configure({
      executionRoute,
      workspace: "/another",
      kernel,
      harnessSnapshot: snapshotFor("workspace:another"),
    })
    const harnessPinOf = (configured: Configured) =>
      configured.registrations.find((registration) => registration.codec === "tenetkit/harness/snapshot")?.pin

    /**
     * A harness pin is derived from the snapshot the workspace was read for, so two workspaces pin
     * two values. A Server that registered one of them for every Turn made the resolver, which
     * recomputes the expectation from the Run's own workspace, reject a registration it required.
     */
    expect(harnessPinOf(one)).toBeDefined()
    expect(harnessPinOf(another)).toBeDefined()
    expect(harnessPinOf(one)).not.toBe(harnessPinOf(another))

    const required = ExecutableRegistration.requiredPinsForActiveExecutable({
      ref: one.executable.ref,
      manifest: one.executable.manifest,
    })
    expect(required.has(harnessPinOf(one)!)).toBe(true)
    expect(required.has(harnessPinOf(another)!)).toBe(false)
  }),
)
