import { describe, expect, it } from "@effect/vitest"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Effect, Exit, Layer } from "effect"
import { ProductAgent } from "../src/index"
import { provideLayer } from "./layer"
import { executionRoute } from "./current-state"

describe("ProductAgent", () => {
  it.effect("delegates every service operation, maps failures, and selects every profile", () =>
    Effect.gen(function* () {
      const failure = ExecutionBackend.BackendError.make({ message: "nope" })
      const inspection: ExecutionBackend.FanOutInspection = {
        fanOutId: "fan",
        parentTurnId: "parent",
        state: "joining",
        maxConcurrency: 2,
        join: "quorum",
        members: [],
      }
      const backend = ExecutionBackend.Service.of({
        invokeChild: () => Effect.fail(failure),
        createFanOut: (input) => Effect.succeed({ ...inspection, fanOutId: input.fanOutId, join: input.join }),
        inspectFanOut: (id) => Effect.succeed(id === "fan" ? inspection : undefined),
        cancelFanOut: () => Effect.succeed(inspection),
        registerWorkflows: () => Effect.die("unused"),
        startWorkflow: () => Effect.die("unused"),
        inspectWorkflow: () => Effect.die("unused"),
        cancelWorkflow: () => Effect.die("unused"),
        start: () => Effect.die("unused"),
        replay: () => Effect.die("unused"),
        cancel: (id) => Effect.succeed({ turnId: id, status: "cancelled", events: [] }),
        inspect: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        listApprovals: () => Effect.die("unused"),
        resolveToolApproval: () => Effect.die("unused"),
        resolvePermission: () => Effect.die("unused"),
      })
      const layer = ProductAgent.layer.pipe(Layer.provide(Layer.succeed(ExecutionBackend.Service, backend)))
      yield* Effect.gen(function* () {
        const agents = yield* ProductAgent.Service
        expect(
          (yield* Effect.flip(agents.invoke({ parentTurnId: "p", childId: "c", profile: "Task", prompt: "x" })))
            .message,
        ).toBe("nope")
        expect(
          (yield* agents.fanOut({
            parentTurnId: "p",
            fanOutId: "direct",
            executionRoute: executionRoute(),
            children: [],
            maxConcurrency: 1,
            join: "all",
            createdAt: 1,
          })).fanOutId,
        ).toBe("direct")
        expect(yield* agents.inspectFanOut("missing")).toBeUndefined()
        expect((yield* agents.cancelFanOut("fan", 2, "stop")).state).toBe("joining")
        expect((yield* agents.cancelChild("kid", 3)).turnId).toBe("kid")
        expect(
          (yield* agents.runParallel({
            parentTurnId: "p",
            fanOutId: "parallel",
            executionRoute: executionRoute(),
            tasks: [{ id: "a", prompt: "x", profile: "Oracle" }],
            maxConcurrency: 1,
            quorum: 1,
            createdAt: 1,
          })).join,
        ).toBe("all")
        expect(
          (yield* agents.runReviewLanes({
            parentTurnId: "p",
            fanOutId: "review",
            executionRoute: executionRoute(),
            checks: [{ id: "a", prompt: "x" }],
            maxConcurrency: 1,
            quorum: 1,
            createdAt: 1,
          })).join,
        ).toBe("best-effort")
      }).pipe(provideLayer(layer))
      expect(
        [
          "review",
          "research",
          "documentation",
          "architecture",
          "investigate",
          "image",
          "visual",
          "thread",
          "other",
        ].map(ProductAgent.selectProfile),
      ).toEqual(["Review", "Librarian", "Librarian", "Oracle", "Oracle", "Painter", "Painter", "ReadThread", "Task"])
    }),
  )

  it.effect("preserves parent and child correlation without exposing Relay identifiers", () =>
    Effect.gen(function* () {
      const backend = ExecutionBackend.Service.of({
        invokeChild: (input) =>
          Effect.succeed({
            parentTurnId: input.parentTurnId,
            childId: input.childId,
            profile: input.profile,
            type: "accepted",
          }),
        createFanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
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
      })
      const result = yield* Effect.gen(function* () {
        const agents = yield* ProductAgent.Service
        return yield* agents.invoke({
          parentTurnId: "turn-1",
          childId: "research-1",
          profile: "Oracle",
          prompt: "Find evidence",
        })
      }).pipe(provideLayer(ProductAgent.layer.pipe(Layer.provide(Layer.succeed(ExecutionBackend.Service, backend)))))
      expect(result).toEqual({
        parentTurnId: "turn-1",
        childId: "research-1",
        profile: "Oracle",
        type: "accepted",
      })
    }),
  )

  it.effect("cancels the exact inspected child execution identifier", () =>
    Effect.gen(function* () {
      let cancelledId: string | undefined
      const childExecutionId = "execution:parent:child:Review:call-review"
      const backend = ExecutionBackend.Service.of({
        invokeChild: () => Effect.die("unused"),
        createFanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        registerWorkflows: () => Effect.die("unused"),
        startWorkflow: () => Effect.die("unused"),
        inspectWorkflow: () => Effect.die("unused"),
        cancelWorkflow: () => Effect.die("unused"),
        start: () => Effect.die("unused"),
        replay: () => Effect.die("unused"),
        cancel: (executionId) => {
          cancelledId = executionId
          return Effect.succeed({ turnId: executionId, status: "cancelled", events: [] })
        },
        inspect: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        listApprovals: () => Effect.die("unused"),
        resolveToolApproval: () => Effect.die("unused"),
        resolvePermission: () => Effect.die("unused"),
      })
      const result = yield* Effect.gen(function* () {
        const agents = yield* ProductAgent.Service
        return yield* agents.cancelChild(childExecutionId, 2)
      }).pipe(provideLayer(ProductAgent.layer.pipe(Layer.provide(Layer.succeed(ExecutionBackend.Service, backend)))))

      expect(cancelledId).toBe(childExecutionId)
      expect(result.status).toBe("cancelled")
    }),
  )

  it.effect("cancels the child returned by backend inspection without rewriting its identifier", () =>
    Effect.gen(function* () {
      const parentTurnId = "turn-product-child-cancel"
      const childExecutionId = "execution:turn-product-child-cancel:child:Review:call-cancel-review"
      let childStatus: ExecutionBackend.Status = "running"
      const backend = ExecutionBackend.Service.of({
        invokeChild: () => Effect.die("unused"),
        createFanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        registerWorkflows: () => Effect.die("unused"),
        startWorkflow: () => Effect.die("unused"),
        inspectWorkflow: () => Effect.die("unused"),
        cancelWorkflow: () => Effect.die("unused"),
        start: () => Effect.die("unused"),
        replay: () => Effect.die("unused"),
        cancel: (executionId) =>
          executionId === childExecutionId
            ? Effect.sync(() => {
                childStatus = "cancelled"
                return { turnId: executionId, status: childStatus, events: [] }
              })
            : Effect.die(`Unexpected execution identifier: ${executionId}`),
        inspect: (executionId) =>
          Effect.sync(() => {
            if (executionId === parentTurnId)
              return {
                turnId: parentTurnId,
                status: "running" as const,
                waits: [],
                pendingTools: [],
                children: [{ executionId: childExecutionId, status: childStatus }],
              }
            if (executionId === childExecutionId)
              return {
                turnId: childExecutionId,
                status: childStatus,
                waits: [],
                pendingTools: [],
                children: [],
              }
            return undefined
          }),
        steer: () => Effect.die("unused"),
        listApprovals: () => Effect.die("unused"),
        resolveToolApproval: () => Effect.die("unused"),
        resolvePermission: () => Effect.die("unused"),
      })
      const result = yield* Effect.gen(function* () {
        const agents = yield* ProductAgent.Service
        const parent = yield* backend.inspect(parentTurnId)
        const inspectedChildId = parent?.children[0]?.executionId
        if (inspectedChildId === undefined) return yield* Effect.die("Missing handoff child")
        const cancelled = yield* agents.cancelChild(inspectedChildId, 2)
        const child = yield* backend.inspect(inspectedChildId)
        return { inspectedChildId, cancelled, child }
      }).pipe(provideLayer(ProductAgent.layer.pipe(Layer.provide(Layer.succeed(ExecutionBackend.Service, backend)))))

      expect(result.inspectedChildId).toBe(childExecutionId)
      expect(result.cancelled).toMatchObject({ turnId: childExecutionId, status: "cancelled" })
      expect(result.child).toMatchObject({ turnId: childExecutionId, status: "cancelled" })
    }),
  )

  it.effect("maps backend failures for every delegated fan-out operation", () =>
    Effect.gen(function* () {
      const failure = ExecutionBackend.BackendError.make({ message: "backend unavailable" })
      const backend = ExecutionBackend.Service.of({
        invokeChild: () => Effect.die("unused"),
        createFanOut: () => Effect.fail(failure),
        inspectFanOut: () => Effect.fail(failure),
        cancelFanOut: () => Effect.fail(failure),
        registerWorkflows: () => Effect.die("unused"),
        startWorkflow: () => Effect.die("unused"),
        inspectWorkflow: () => Effect.die("unused"),
        cancelWorkflow: () => Effect.die("unused"),
        start: () => Effect.die("unused"),
        replay: () => Effect.die("unused"),
        cancel: () => Effect.fail(failure),
        inspect: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        listApprovals: () => Effect.die("unused"),
        resolveToolApproval: () => Effect.die("unused"),
        resolvePermission: () => Effect.die("unused"),
      })
      const layer = ProductAgent.layer.pipe(Layer.provide(Layer.succeed(ExecutionBackend.Service, backend)))
      yield* Effect.gen(function* () {
        const agents = yield* ProductAgent.Service
        const effects: ReadonlyArray<Effect.Effect<unknown, ProductAgent.InvocationError>> = [
          agents.fanOut({
            parentTurnId: "p",
            fanOutId: "f",
            executionRoute: executionRoute(),
            children: [],
            maxConcurrency: 1,
            join: "all",
            createdAt: 1,
          }),
          agents.inspectFanOut("f"),
          agents.cancelFanOut("f", 2),
          agents.cancelChild("c", 2),
          agents.runParallel({
            parentTurnId: "p",
            fanOutId: "p",
            executionRoute: executionRoute(),
            tasks: [],
            maxConcurrency: 1,
            createdAt: 1,
          }),
          agents.runReviewLanes({
            parentTurnId: "p",
            fanOutId: "r",
            executionRoute: executionRoute(),
            checks: [],
            maxConcurrency: 1,
            createdAt: 1,
          }),
        ]
        for (const effect of effects) {
          const exit = yield* Effect.exit(effect)
          expect(Exit.isFailure(exit)).toBe(true)
        }
      }).pipe(provideLayer(layer))
    }),
  )

  it.effect("selects subagents, bounds parallel Tasks, preserves partial failures, and projects ordered children", () =>
    Effect.gen(function* () {
      let captured: ExecutionBackend.FanOutInput | undefined
      const backend = ExecutionBackend.Service.of({
        invokeChild: () => Effect.die("unused"),
        createFanOut: (input) => {
          captured = input
          return Effect.succeed({
            fanOutId: input.fanOutId,
            parentTurnId: input.parentTurnId,
            state: "satisfied",
            maxConcurrency: input.maxConcurrency,
            join: input.join,
            members: [
              { childId: input.children[0]!.childId, ordinal: 0, state: "completed", output: "ok" },
              { childId: input.children[1]!.childId, ordinal: 1, state: "failed", error: "check failed" },
            ],
          })
        },
        inspectFanOut: () => Effect.die("unused"),
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
      })
      const result = yield* Effect.gen(function* () {
        const agents = yield* ProductAgent.Service
        const inspection = yield* agents.runParallel({
          parentTurnId: "parent",
          fanOutId: "fan",
          executionRoute: executionRoute(),
          tasks: [
            { id: "a", prompt: "research APIs", model: "gpt-5.6-luna" },
            { id: "b", prompt: "implement it" },
          ],
          maxConcurrency: 1,
          join: "best-effort",
          createdAt: 10,
        })
        return { inspection, projected: agents.projectChildren(inspection) }
      }).pipe(provideLayer(ProductAgent.layer.pipe(Layer.provide(Layer.succeed(ExecutionBackend.Service, backend)))))
      expect(captured?.maxConcurrency).toBe(1)
      expect(captured?.children.map((child) => child.profile)).toEqual(["Librarian", "Task"])
      expect(captured?.children.map((child) => child.model)).toEqual(["gpt-5.6-luna", undefined])
      expect(result.projected).toEqual([
        { parentTurnId: "parent", fanOutId: "fan", childId: "a", ordinal: 0, state: "completed", output: "ok" },
        { parentTurnId: "parent", fanOutId: "fan", childId: "b", ordinal: 1, state: "failed", error: "check failed" },
      ])
    }),
  )
})
