import { expect, it } from "@effect/vitest"
import { ExecutableManifest } from "@batonfx/core"
import * as Settings from "@rika/configuration/configuration-settings"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import * as JavaScriptSandbox from "@rika/javascript-sandbox/javascript-sandbox"
import { Cause, Effect, Exit, Schema } from "effect"
import { configure } from "../src/baton-route"
import * as ChildTools from "../src/baton-child-tools"

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
    expect(first.version).toBe(2)
    expect(first.tokenBudget).toBe(12_000)
    expect(first.main.registrationIdentity).toMatch(/^rika:model:v2:[a-f0-9]{64}$/)
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
    const executionRoute = testExecutionRoute()
    const configured = yield* configure({ executionRoute, workspace: "/workspace", sandbox })
    expect(Object.keys(configured.profiles)).toEqual([
      "Title",
      "Compaction",
      "Oracle",
      "Librarian",
      "Painter",
      "ReadThread",
      "Review",
      "Surgeon",
      "Task",
    ])
    expect(configured.resolverEntries).toHaveLength(10)
    const rootResolution = configured.resolverEntries[0]!
    expect("agent" in rootResolution ? rootResolution.agent.model : undefined).toMatchObject({
      provider: "@batonfx/providers",
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
      "Title",
    ])
    const rootToolNames = rootEntry?._tag === "Agent" ? rootEntry.manifest.tools.map(({ name }) => name) : []
    expect(rootToolNames.filter((name) => name in ChildTools.selections)).toEqual([
      "librarian",
      "oracle",
      "painter",
      "read_thread",
      "surgeon",
      "task",
      "title",
    ])
    expect(rootToolNames).toContain("read")
    expect(configured.profiles.Title!.manifest.tools).toEqual([])
    expect(configured.profiles.Compaction!.manifest.tools).toEqual([])
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
      configured.profiles.Task!.manifest.tools.map(({ name }) => name).filter((name) => name in ChildTools.selections),
    ).toEqual(["librarian", "oracle", "painter", "read_thread", "surgeon"])
    expect(rootEntry?._tag === "Agent" ? rootEntry.manifest.compaction : undefined).toMatchObject({
      contextWindow: executionRoute.main.compaction.contextWindow,
      keepRecentTokens: executionRoute.main.compaction.keepRecentTokens,
      reserveTokens: executionRoute.main.compaction.reserveTokens,
      strategyIdentity: executionRoute.compaction.strategy,
      summaryModel: configured.profiles.Compaction!.manifest.model,
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
    for (const name of Object.keys(ChildTools.selections)) {
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
