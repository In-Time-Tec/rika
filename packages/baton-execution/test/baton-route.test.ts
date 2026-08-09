import { expect, it } from "@effect/vitest"
import { ExecutableManifest } from "@batonfx/core"
import { CellTool } from "@batonfx/repl"
import { ExecutableRegistration } from "@batonfx/runtime"
import * as Settings from "@rika/configuration/configuration-settings"
import * as KernelProfileRegistration from "@rika/kernel/kernel-profile-registration"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Cause, ConfigProvider, Effect, Exit, Schema } from "effect"
import * as Registration from "../src/baton-registration"
import { configure } from "../src/baton-route"

const kernel = { runtimeVersion: "1.3.14", dataRoot: "/data" } as const

const conversationalProfiles = ["Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon", "Task"] as const

type Configured = Effect.Success<ReturnType<typeof configure>>

const agentEntries = (configured: Configured) =>
  configured.executable.manifest.entries.flatMap((entry) => (entry._tag === "Agent" ? [entry] : []))

const profileNameOf = (entry: ReturnType<typeof agentEntries>[number]) => entry.manifest.name.replace("rika-", "")

const modelCandidates = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

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
    expect(first.version).toBe(1)
    expect(first.tokenBudget).toBe(12_000)
    expect(first.main.registrationIdentity).toMatch(/^rika:model:v1:[a-f0-9]{64}$/)
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
    expect(rootToolNames).toEqual([CellTool.name])
    expect(configured.profiles.Title!.manifest.tools).toEqual([])
    for (const profile of Object.values(configured.profiles)) {
      expect(profile.manifest.budget.totalTokens).toBe(10_000_000)
      expect(profile.manifest.budget.modelCalls).toBeGreaterThan(0)
    }
    for (const name of conversationalProfiles) {
      expect(configured.profiles[name]!.manifest.tools.map(({ name: toolName }) => toolName)).toEqual([CellTool.name])
    }
    expect(configured.profiles.Task!.manifest.children.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "ReadThread",
      "Surgeon",
    ])
    expect(configured.profiles.Task!.manifest.children.map(({ selection }) => selection)).not.toContain("Task")
    for (const entry of agentEntries(configured)) {
      const names = entry.manifest.tools.map(({ name }) => name)
      expect(names).toEqual(profileNameOf(entry) === "title" ? [] : [CellTool.name])
      expect(entry.manifest.toolScheduling).toEqual({ maxConcurrency: 1, parallelSafe: [] })
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
    const encodedRegistrations = encodeRegistrations(configured.registrations)
    for (const credential of credentialValues) expect(encodedRegistrations).not.toContain(credential)

    expect(
      configured.registrations.every(
        (registration) => new TextEncoder().encode(JSON.stringify(registration)).byteLength <= 65_536,
      ),
    ).toBe(true)
    const registrationPins = new Set(configured.registrations.map(({ pin }) => pin))
    expect(registrationPins).toEqual(ExecutableRegistration.requiredPins(configured.executable))
    yield* ExecutableRegistration.validate(configured.executable, configured.registrations)
    expect(
      configured.registrations
        .filter(({ codec }) => codec === "rika-tool")
        .map(({ payload }) => (payload as { readonly name: string }).name),
    ).toContain(CellTool.name)
    for (const name of ["run_child", "start_child_group", "await_child_group"]) {
      expect(
        configured.registrations.some(
          ({ codec, payload }) => codec === "rika-tool" && (payload as { readonly name?: string }).name === name,
        ),
      ).toBe(false)
    }
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

it.effect("pins the product token budget into every Agent manifest", () =>
  Effect.gen(function* () {
    const executable = yield* configure({
      executionRoute: { ...testExecutionRoute(), tokenBudget: 12_000 },
      workspace: "/workspace",
      kernel,
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

it.effect("advertises exactly one tool named typescript per conversational profile and none for Title", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
    })
    const advertised = new Map(
      agentEntries(configured).map((entry) => [profileNameOf(entry), entry.manifest.tools.map(({ name }) => name)]),
    )
    expect([...advertised.keys()].toSorted()).toEqual([
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
    expect(advertised.get("title")).toEqual([])
    for (const [name, tools] of advertised) {
      if (name === "title") continue
      expect(tools).toEqual(["typescript"])
      expect(tools).toHaveLength(1)
    }
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
      "Title",
    ])
    expect(configured.profiles.Task!.manifest.children.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "ReadThread",
      "Surgeon",
    ])
    for (const name of ["Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon"] as const) {
      expect(configured.profiles[name]!.manifest.children).toEqual([])
    }
    for (const entry of agentEntries(configured)) {
      for (const child of entry.manifest.children) {
        expect(configured.executable.manifest.entries.some(({ pin }) => pin === child.agent)).toBe(true)
      }
    }
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
