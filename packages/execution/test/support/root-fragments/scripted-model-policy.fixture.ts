import { expect, it } from "@effect/vitest"
import { ExecutableManifest } from "generalist"
import * as NativeTools from "../../../src/tool/registry"
import { ExecutableRegistration } from "generalist/runtime"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"
import { Effect } from "effect"
import { configure } from "../adapters"

const conversationalProfiles = ["Oracle", "Librarian", "Painter", "Review", "Surgeon", "Task"] as const

type Configured = Effect.Success<ReturnType<typeof configure>>

const agentEntries = (configured: Configured) =>
  [...configured.executable.manifest.entries, ...configured.titleExecutable.manifest.entries].flatMap((entry) =>
    entry._tag === "Agent" ? [entry] : [],
  )

const profileNameOf = (entry: ReturnType<typeof agentEntries>[number]) => entry.manifest.name.replace("rika-", "")
const nativeToolNames = Object.values(NativeTools.toolkit.tools)
  .map(({ name }) => name)
  .toSorted()

type RouteModel = ReturnType<typeof testExecutionRoute>["main"]

const distinct = (model: RouteModel, identity: string): RouteModel => ({
  ...model,
  registrationIdentity: modelRegistrationIdentity(identity),
  candidates: model.candidates.map((candidate) => ({
    ...candidate,
    registrationIdentity: modelRegistrationIdentity(identity),
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
        review: distinct(base.agents.review, "identity-review"),
        surgeon: distinct(base.agents.surgeon, shared === "surgeon" ? "identity-shared" : "identity-surgeon"),
        task: distinct(base.agents.task, "identity-task"),
      },
    })
    const asOracle = yield* configure({ executionRoute: spread("oracle"), workspace: "/workspace" })
    const asSurgeon = yield* configure({ executionRoute: spread("surgeon"), workspace: "/workspace" })
    const first = registryPayloads(asOracle.registrations)
    const second = registryPayloads(asSurgeon.registrations)
    const shared = [...first.keys()].filter((pin) => second.has(pin))
    expect(shared.length).toBeGreaterThan(0)
    for (const pin of shared) expect([pin, second.get(pin)]).toEqual([pin, first.get(pin)])
    yield* ExecutableRegistration.validate(asOracle.executable, asOracle.registrations)
    yield* ExecutableRegistration.validate(asSurgeon.executable, asSurgeon.registrations)
  }),
)

it.effect("pins child authority without duplicating Generalist-owned tools in host manifests", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
    })
    const entries = agentEntries(configured)
    expect([...new Set(entries.map(profileNameOf))].toSorted()).toEqual([
      "librarian",
      "oracle",
      "painter",
      "review",
      "root",
      "surgeon",
      "task",
      "title",
    ])
    for (const entry of entries) {
      const tools = entry.manifest.tools.map(({ name }) => name)
      if (profileNameOf(entry) === "title") expect(tools).toEqual([])
      else expect(tools).toEqual(nativeToolNames)
    }
    expect(configured.executable.manifest.profiles).toHaveLength(conversationalProfiles.length)
  }),
)

it.effect("schedules native tools as one exclusive barrier that is never parallel safe", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
    })
    for (const entry of agentEntries(configured)) {
      expect(entry.manifest.toolScheduling.maxConcurrency).toBe(1)
      expect(entry.manifest.toolScheduling.parallelSafe).toEqual([])
    }
  }),
)

it.effect("keeps parent-relative child selection authority pinned after the native tool swap", () =>
  Effect.gen(function* () {
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
    })
    const rootEntry = configured.executable.manifest.entries.find(({ pin }) => pin === configured.executable.ref.active)
    expect(rootEntry?._tag === "Agent" ? rootEntry.manifest.children.map(({ selection }) => selection) : []).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "Review",
      "Surgeon",
      "Task",
    ])
    expect(configured.profiles.Task!.manifest.children.map(({ selection }) => selection)).toEqual([
      "Librarian",
      "Oracle",
      "Painter",
      "Review",
      "Surgeon",
      "Task",
    ])
    for (const name of ["Oracle", "Librarian", "Painter", "Review", "Surgeon"] as const) {
      expect(configured.profiles[name]!.manifest.children.map(({ selection }) => selection)).toEqual([
        "Librarian",
        "Oracle",
        "Painter",
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
    })
    const root = agentEntries(configured).find(({ pin }) => pin === configured.executable.ref.active)!
    expect(root.manifest.children).toHaveLength(conversationalProfiles.length)
    expect(root.manifest.tools.map(({ name }) => name)).toEqual(nativeToolNames)
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
      skills: [{ name: "writing-rika-tests", digest: "digest-one" }],
    })
    const changed = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
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
      skills,
    })
    const reversed = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      skills: skills.toReversed(),
    })
    expect(reversed.executable.ref.active).toBe(forward.executable.ref.active)
  }),
)
