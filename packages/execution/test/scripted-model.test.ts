import "./support/root-fragments/scripted-model-policy.fixture"
import { expect, it } from "@effect/vitest"
import { ExecutableManifest } from "generalist"
import * as NativeTools from "../src/tool/registry"
import { ExecutableRegistration } from "generalist/runtime"
import * as Settings from "@rika/configuration/configuration-settings"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"
import { Cause, ConfigProvider, Effect, Exit, Schema } from "effect"
import * as Registration from "../src/registration"
import { configure } from "./support/adapters"

const conversationalProfiles = ["Oracle", "Librarian", "Painter", "Review", "Surgeon", "Task"] as const

type Configured = Effect.Success<ReturnType<typeof configure>>

const agentEntries = (configured: Configured) =>
  [...configured.executable.manifest.entries, ...configured.titleExecutable.manifest.entries].flatMap((entry) =>
    entry._tag === "Agent" ? [entry] : [],
  )

const profileNameOf = (entry: ReturnType<typeof agentEntries>[number]) => entry.manifest.name.replace("rika-", "")

const modelCandidates = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const nativeToolNames = Object.values(NativeTools.toolkit.tools)
  .map(({ name }) => name)
  .toSorted()

/**
 * Values a host holds as credentials. A registration that carried any of these would leak it into
 * durable state, so the assertion names the real values rather than a word they happen to contain:
 * a key like `sk-proj-0a1b2c3d` contains no such word and would pass an unconstrained search.
 */
const credentialValues = ["switchboard-secret", "sk-proj-0a1b2c3d4e5f", "ghp_0123456789abcdef", "hunter2"] as const

const encodeRegistrations = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const assertProfileTools = (configured: Configured) => {
  for (const profile of Object.values(configured.profiles)) expect(profile.manifest.budget).toEqual({})
  for (const name of conversationalProfiles) {
    expect(configured.profiles[name]!.manifest.tools.map(({ name: toolName }) => toolName)).toEqual(nativeToolNames)
  }
  for (const entry of agentEntries(configured)) {
    const names = entry.manifest.tools.map(({ name }) => name)
    expect(names).toEqual(profileNameOf(entry) === "title" ? [] : nativeToolNames)
    expect(entry.manifest.toolScheduling).toEqual({ maxConcurrency: 1, parallelSafe: [] })
  }
}

const assertRegistrationPins = (configured: Configured, registrationPins: ReadonlySet<string>) => {
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
}

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
          ...orderedSettings.models[mainAlias],
          candidates: orderedSettings.models[mainAlias].candidates.toReversed(),
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
        registrationIdentity: modelRegistrationIdentity("test-compaction-route"),
      },
    }
    const configured = yield* configure({ executionRoute, workspace: "/workspace" })
    expect(Object.keys(configured.profiles)).toEqual([
      "Title",
      "Oracle",
      "Librarian",
      "Painter",
      "Review",
      "Surgeon",
      "Task",
    ])
    expect(configured.resolverEntries).toHaveLength(8)
    const rootResolution = configured.resolverEntries[0]!
    expect("agent" in rootResolution ? rootResolution.agent.model : undefined).toMatchObject({
      provider: "generalist/ai",
      model: "ordered-route",
    })
    expect(configured.executable.manifest.version).toBe("2")
    const rootEntry = configured.executable.manifest.entries.find(({ pin }) => pin === configured.executable.ref.active)
    expect(rootEntry?._tag).toBe("Agent")
    const rootAgentEntry = agentEntries(configured).find(({ pin }) => pin === configured.executable.ref.active)!
    expect(rootAgentEntry.manifest.children.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "Review",
      "Surgeon",
      "Task",
    ])
    const rootToolNames = rootAgentEntry.manifest.tools.map(({ name }) => name)
    expect(rootToolNames).toEqual(nativeToolNames)
    expect(configured.profiles.Title!.manifest.tools).toEqual([])
    assertProfileTools(configured)
    expect(configured.profiles.Task!.manifest.children.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "Review",
      "Surgeon",
      "Task",
    ])
    expect(configured.executable.manifest.profiles.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "Review",
      "Surgeon",
      "Task",
    ])
    const compactionSummaryPromptIdentity =
      rootEntry?._tag === "Agent" ? rootEntry.manifest.compaction?.summaryPromptIdentity : undefined
    expect(compactionSummaryPromptIdentity).toMatch(/^[a-f0-9]{64}$/)
    expect(rootEntry?._tag === "Agent" ? rootEntry.manifest.compaction : undefined).toMatchObject({
      contextWindow: executionRoute.main.compaction.contextWindow,
      keepRecentTokens: executionRoute.main.compaction.keepRecentTokens,
      reserveTokens: executionRoute.main.compaction.reserveTokens,
      strategyIdentity: executionRoute.compaction.strategy,
      summaryModel: configured.registrations.find(
        (registration) =>
          registration.codec === "rika-model-route" &&
          Schema.decodeUnknownSync(Registration.codecs.modelRoute.payload)(registration.payload).role === "compaction",
      )?.pin,
      summaryPromptIdentity: compactionSummaryPromptIdentity,
    })
    expect("runOptions" in rootResolution ? rootResolution.runOptions?.compaction : undefined).toEqual({
      contextWindow: executionRoute.main.compaction.contextWindow,
      reserveTokens: executionRoute.main.compaction.reserveTokens,
    })
    expect(configured.registrations.find((registration) => registration.codec === "rika-compaction")?.payload).toEqual({
      keepRecentTokens: executionRoute.main.compaction.keepRecentTokens,
      strategyIdentity: "default",
      summaryPromptIdentity: compactionSummaryPromptIdentity,
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
        .map(({ payload }) => Schema.decodeUnknownSync(Registration.codecs.tool.payload)(payload).name),
    ).toEqual(expect.arrayContaining(nativeToolNames))
    const advertised = new Set(
      agentEntries(configured).flatMap((entry) => entry.manifest.tools.map(({ name }) => name)),
    )
    expect([...advertised].toSorted()).toEqual(nativeToolNames.toSorted())
    assertRegistrationPins(configured, registrationPins)
  }),
)

it.effect("delegates persisted provider-option decoding to Generalist", () =>
  Effect.gen(function* () {
    const route = testExecutionRoute()
    const candidate = {
      ...route.main.candidates[0]!,
      model: "bedrock-test",
      registrationIdentity: modelRegistrationIdentity("bedrock-registration"),
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
    const configured = yield* configure({ executionRoute, workspace: "/workspace" })
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
      registrationIdentity: modelRegistrationIdentity("test-fallback"),
    }
    const ordered = { ...first, main: { ...first.main, candidates: [first.main.candidates[0]!, secondCandidate] } }
    const reversed = { ...ordered, main: { ...ordered.main, candidates: ordered.main.candidates.toReversed() } }
    const orderedExecutable = yield* configure({ executionRoute: ordered, workspace: "/one" })
    const reversedExecutable = yield* configure({ executionRoute: reversed, workspace: "/one" })
    const otherWorkspace = yield* configure({ executionRoute: ordered, workspace: "/two" })
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
      registrationIdentity: modelRegistrationIdentity("switchboard-registration"),
      providerOptions: { max_output_tokens: 4_096 },
    }
    const executionRoute = { ...route, main: { ...route.main, candidates: [candidate] } }
    const configured = yield* configure({ executionRoute, workspace: "/workspace" }).pipe(
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
      registrationIdentity: modelRegistrationIdentity("chat-compatible-registration"),
      providerOptions: { max_tokens: 4_096 },
    }
    const executionRoute = { ...route, main: { ...route.main, candidates: [candidate] } }
    const configured = yield* configure({ executionRoute, workspace: "/workspace" }).pipe(
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
      registrationIdentity: modelRegistrationIdentity("switchboard-registration"),
      providerOptions: { max_output_tokens: 4_096 },
    }
    const executionRoute = { ...route, main: { ...route.main, candidates: [candidate] } }
    const failed = yield* configure({ executionRoute, workspace: "/workspace" }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
      Effect.exit,
    )
    expect(Exit.isFailure(failed)).toBe(true)
    const pretty = Exit.isFailure(failed) ? Cause.pretty(failed.cause) : ""
    expect(pretty).toContain("SWITCHBOARD_API_KEY")
    expect(pretty).not.toContain("Unable to get redacted value")
  }),
)
