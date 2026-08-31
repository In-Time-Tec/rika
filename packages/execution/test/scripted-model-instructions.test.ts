import { expect, it } from "@effect/vitest"
import { State } from "tenetkit/agent-guidance"
import { ExecutableRegistration } from "tenetkit/runtime"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Effect } from "effect"
import { profileInstructions } from "../src/routing/route"
import { configure } from "./support/adapters"

const kernel = { runtimeVersion: "1.3.14", dataRoot: "/data" } as const

type Configured = Effect.Success<ReturnType<typeof configure>>

const agentEntries = (configured: Configured) =>
  [...configured.executable.manifest.entries, ...configured.titleExecutable.manifest.entries].flatMap((entry) =>
    entry._tag === "Agent" ? [entry] : [],
  )

const profileNameOf = (entry: ReturnType<typeof agentEntries>[number]) => entry.manifest.name.replace("rika-", "")

it.effect("carries a harness refinement into the instructions the root agent is given", () =>
  Effect.gen(function* () {
    const executionRoute = testExecutionRoute()
    const empty = State.empty("global")
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

const budgetDimensions = [
  "modelCalls",
  "toolCalls",
  "totalTokens",
  "childRuns",
  "handoffs",
  "depth",
  "deadline",
] as const

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
          const budget = resolution.agent.budget ?? {}
          expect(
            resolution.agent.budget,
            `${resolution.agent.name} must carry an explicit budget the host cannot default`,
          ).toBeDefined()
          for (const dimension of budgetDimensions)
            expect(budget[dimension], `${resolution.agent.name} must not cap ${dimension}`).toBeUndefined()
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
              entry.manifest.budget[dimension],
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
    const empty = State.empty("global")
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
      configured.registrations.find((registration) => registration.codec === "tenetkit/agent-guidance/snapshot")?.pin

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
