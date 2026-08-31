import { expect, it } from "@effect/vitest"
import { ExecutableManifest } from "tenetkit"
import { CellTool } from "tenetkit/repl"
import { ExecutableRegistration } from "tenetkit/runtime"
import * as KernelProfileRegistration from "@rika/kernel/kernel-profile-registration"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"
import { Cause, Effect, Exit, Schema } from "effect"
import * as Registration from "../../../src/registration"
import { configure } from "../adapters"

const kernel = { runtimeVersion: "1.3.14", dataRoot: "/data" } as const

const conversationalProfiles = ["Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon", "Task"] as const

type Configured = Effect.Success<ReturnType<typeof configure>>

const agentEntries = (configured: Configured) =>
  [...configured.executable.manifest.entries, ...configured.titleExecutable.manifest.entries].flatMap((entry) =>
    entry._tag === "Agent" ? [entry] : [],
  )

const profileNameOf = (entry: ReturnType<typeof agentEntries>[number]) => entry.manifest.name.replace("rika-", "")

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
        { ...kernel, limits: { sourceBytes: 1_024, cellDeadlineMillis: 5_000 } },
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
              ...Schema.decodeUnknownSync(Registration.codecs.kernelProfile.payload)(registration.payload),
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
