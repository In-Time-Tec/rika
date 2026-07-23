import { describe, expect, it } from "@effect/vitest"
import { AgentProfiles } from "@rika/runtime"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Catalog } from "@rika/tools"
import { Effect, Layer, Schema } from "effect"
import { ProductAgent } from "../src"
import { provideLayer } from "./layer"
import { executionRoute } from "./current-state"

const model = { provider: "test", model: "deterministic" }
const specialtyNames = ["task", "oracle", "librarian"] as const
const cases = [
  {
    tool: "task",
    profile: "Task",
    output: { summary: "Implemented and verified.", files: ["src/change.ts"] },
    permissions: ["workspace.read", "workspace.write", "process.run", "network.read", "thread.read"],
  },
  {
    tool: "oracle",
    profile: "Oracle",
    output: { answer: "Use the public boundary.", evidence: ["packages/runtime/src/index.ts:1"] },
    permissions: ["workspace.read", "network.read", "thread.read"],
  },
  {
    tool: "librarian",
    profile: "Librarian",
    output: { answer: "The documented API is current.", sources: ["https://example.test/docs"] },
    permissions: ["network.read", "thread.read"],
  },
  {
    tool: "painter",
    profile: "Painter",
    output: { text: "Rendered.", artifact: { path: "artifacts/card.png", mimeType: "image/png", kind: "image" } },
    permissions: ["workspace.read", "thread.read"],
  },
] as const

const backendLayer = (failProfile?: ExecutionBackend.AgentProfile) =>
  Layer.succeed(
    ExecutionBackend.Service,
    ExecutionBackend.Service.of({
      invokeChild: (input) =>
        input.profile === failProfile
          ? Effect.fail(ExecutionBackend.BackendError.make({ message: `${input.profile} failed` }))
          : Effect.succeed({
              parentTurnId: input.parentTurnId,
              childId: input.childId,
              profile: input.profile,
              type: "accepted" as const,
            }),
      createFanOut: (input) =>
        Effect.succeed({
          fanOutId: input.fanOutId,
          parentTurnId: input.parentTurnId,
          state: input.children.some((child) => child.profile === failProfile) ? "failed" : "satisfied",
          maxConcurrency: input.maxConcurrency,
          join: input.join,
          members: input.children.map((child, ordinal) => ({
            childId: child.childId,
            ordinal,
            state: child.profile === failProfile ? "failed" : "completed",
            ...(child.profile === failProfile
              ? { error: `${child.profile} failed` }
              : { output: cases[ordinal]?.output }),
          })),
        }),
      inspectFanOut: () => Effect.void.pipe(Effect.as(undefined)),
      cancelFanOut: () => Effect.die("unused"),
      registerWorkflows: () => Effect.die("unused"),
      startWorkflow: () => Effect.die("unused"),
      inspectWorkflow: () => Effect.die("unused"),
      cancelWorkflow: () => Effect.die("unused"),
      start: () => Effect.die("unused"),
      replay: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
      listApprovals: () => Effect.die("unused"),
      resolveToolApproval: () => Effect.die("unused"),
      resolvePermission: () => Effect.die("unused"),
    }),
  )

describe("specialty durable transcripts", () => {
  it.effect(
    "covers every specialty catalog entry with narrowed profiles, bounded structured output, and parent-child facts",
    () =>
      Effect.gen(function* () {
        expect([...specialtyNames]).toEqual(
          Catalog.definitions
            .filter((definition) => specialtyNames.includes(definition.name as never))
            .map(({ name }) => name),
        )
        expect(cases.map(({ tool }) => tool)).toEqual([...specialtyNames, "painter"])

        const agents = yield* ProductAgent.Service
        for (const entry of cases) {
          const definition = Catalog.get(entry.tool)
          const profile = AgentProfiles.resolve(entry.profile, model)
          expect(profile.preset.permissions).toEqual(entry.permissions)
          expect(
            profile.preset.permissions.every((permission: string) =>
              AgentProfiles.parentPermissions.some((p) => p.name === permission),
            ),
          ).toBe(true)
          if (definition !== undefined)
            expect((yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(entry.output)).length).toBeLessThanOrEqual(
              definition.outputLimit,
            )
          expect(profile.preset).not.toHaveProperty("output_schema_ref")
          expect(
            yield* agents.invoke({
              parentTurnId: "parent-1",
              childId: entry.tool,
              profile: entry.profile,
              prompt: entry.tool,
            }),
          ).toEqual({ parentTurnId: "parent-1", childId: entry.tool, profile: entry.profile, type: "accepted" })
        }

        const inspection = yield* agents.runParallel({
          parentTurnId: "parent-1",
          fanOutId: "specialties-1",
          executionRoute: executionRoute(),
          tasks: cases.map((entry) => ({ id: entry.tool, prompt: entry.tool, profile: entry.profile })),
          maxConcurrency: 2,
          join: "all",
          createdAt: 1,
        })
        expect(inspection.maxConcurrency).toBe(2)
        expect(agents.projectChildren(inspection)).toEqual(
          cases.map((entry, ordinal) => ({
            parentTurnId: "parent-1",
            fanOutId: "specialties-1",
            childId: entry.tool,
            ordinal,
            state: "completed",
            output: entry.output,
          })),
        )
        const review = yield* agents.runReviewLanes({
          parentTurnId: "parent-1",
          fanOutId: "review-1",
          executionRoute: executionRoute(),
          checks: [{ id: "correctness", prompt: "Check correctness" }],
          maxConcurrency: 1,
          join: "best-effort",
          createdAt: 2,
        })
        expect(review).toMatchObject({
          parentTurnId: "parent-1",
          fanOutId: "review-1",
          maxConcurrency: 1,
          join: "best-effort",
          members: [{ childId: "correctness", ordinal: 0, state: "completed" }],
        })
      }).pipe(provideLayer(ProductAgent.layer.pipe(Layer.provide(backendLayer())))),
  )

  it.effect("records deterministic child and fan-out failures", () =>
    Effect.gen(function* () {
      const agents = yield* ProductAgent.Service
      const childFailure = yield* Effect.flip(
        agents.invoke({ parentTurnId: "parent-2", childId: "oracle", profile: "Oracle", prompt: "fail" }),
      )
      expect(childFailure.message).toBe("Oracle failed")
      const fanOut = yield* agents.runParallel({
        parentTurnId: "parent-2",
        fanOutId: "failed-specialty-1",
        executionRoute: executionRoute(),
        tasks: [{ id: "oracle", prompt: "investigate", profile: "Oracle" }],
        maxConcurrency: 1,
        join: "best-effort",
        createdAt: 2,
      })
      expect(fanOut.state).toBe("failed")
      expect(agents.projectChildren(fanOut)[0]).toMatchObject({
        parentTurnId: "parent-2",
        fanOutId: "failed-specialty-1",
        childId: "oracle",
        state: "failed",
        error: "Oracle failed",
      })
    }).pipe(provideLayer(ProductAgent.layer.pipe(Layer.provide(backendLayer("Oracle"))))),
  )

  it.effect("reports Painter unavailable and accepts an injected media-capable route", () =>
    Effect.gen(function* () {
      const unavailable = yield* Effect.exit(AgentProfiles.resolvePainter(model, false))
      expect(unavailable._tag).toBe("Failure")
      const painter = yield* AgentProfiles.resolvePainter(model, true)
      expect(painter.preset.tool_names).toEqual([
        "view_media",
        "task",
        "oracle",
        "librarian",
        "review",
        "read_thread",
        "search_threads",
        "read_thread_transcript",
      ])
      expect(painter.preset).not.toHaveProperty("output_schema_ref")
    }),
  )
})
