import { describe, expect, it } from "@effect/vitest"
import { NestedOperation } from "tenetkit"
import { Context, Effect } from "effect"
import { TestClock } from "effect/testing"
import * as GoalBinding from "@rika/kernel/goal-binding"
import { GoalService, makeMemory } from "@rika/product/goal-service"
import { exhausted } from "@rika/product/goal-record"
import { journal, mountModules } from "./binding-support"

const registry = (nested?: NestedOperation.Interface) =>
  Effect.flatMap(makeMemory, (goals) =>
    mountModules({ modules: [GoalBinding.module], services: Context.make(GoalService, GoalService.of(goals)), nested }),
  )

describe("goal binding", () => {
  it.effect("mounts get, create, and complete and nothing that implies completion", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      expect(mounted.descriptors).toEqual([{ module: "goal", operations: ["get", "create", "complete"] }])
    }),
  )

  it.effect("reports no goal before one is created", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      const response = yield* mounted.invoke({ module: "goal", operation: "get", input: {} })
      expect(response).toEqual({ _tag: "Success", output: {} })
    }),
  )

  it.effect("creates an active goal against the ambient thread, never a cell-supplied one", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      const response = yield* mounted.invoke({
        module: "goal",
        operation: "create",
        input: { objective: "land the migration", threadId: "victim" },
      })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success")
        expect(response.output).toMatchObject({
          threadId: "session",
          status: "active",
          objective: "land the migration",
        })
    }),
  )

  it.effect("refuses a second active goal on one thread", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      yield* mounted.invoke({ module: "goal", operation: "create", input: { objective: "first" } })
      const response = yield* mounted.invoke({ module: "goal", operation: "create", input: { objective: "second" } })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure") expect(response.failure).toMatchObject({ _tag: "GoalAlreadyActive" })
    }),
  )

  it.effect("completes only explicitly, and records the summary", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      yield* mounted.invoke({ module: "goal", operation: "create", input: { objective: "ship" } })
      const response = yield* mounted.invoke({
        module: "goal",
        operation: "complete",
        input: { summary: "shipped" },
      })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success") expect(response.output).toMatchObject({ status: "complete", summary: "shipped" })
    }),
  )

  it.effect("refuses to complete a goal that was never created", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      const response = yield* mounted.invoke({ module: "goal", operation: "complete", input: {} })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure") expect(response.failure).toMatchObject({ _tag: "GoalNotActive" })
    }),
  )

  it.effect("journals create and complete across the durable seam and never journals get", () =>
    Effect.gen(function* () {
      const recorder = journal()
      const mounted = yield* registry(recorder.nested)
      yield* mounted.invoke({ module: "goal", operation: "get", input: {} })
      yield* mounted.invoke({ module: "goal", operation: "create", input: { objective: "o" } })
      yield* mounted.invoke({ module: "goal", operation: "complete", input: {} })
      expect(recorder.kinds).toEqual(["goal.create", "goal.complete"])
      expect(recorder.policies).toEqual(["never", "never"])
    }),
  )
})

describe("goal service", () => {
  it.effect("accumulates usage across turns and pauses at the token budget without completing", () =>
    Effect.gen(function* () {
      const goals = yield* makeMemory
      yield* goals.create({ threadId: "thread", objective: "o", budget: { tokens: 100 } })
      const partial = yield* goals.recordTurn({ threadId: "thread", tokens: 40, elapsedMillis: 10 })
      expect(partial).toMatchObject({ status: "active", usage: { tokens: 40, turns: 1 } })
      const spent = yield* goals.recordTurn({ threadId: "thread", tokens: 60, elapsedMillis: 10 })
      expect(spent).toMatchObject({ status: "paused", usage: { tokens: 100, turns: 2 } })
    }),
  )

  it.effect("derives elapsed from the clock rather than accumulating a counter", () =>
    Effect.gen(function* () {
      const goals = yield* makeMemory
      const created = yield* goals.create({ threadId: "thread", objective: "o", budget: {} })
      yield* TestClock.adjust("5 seconds")
      const completed = yield* goals.complete({ threadId: "thread" })
      expect(completed.completedAtMillis! - created.startedAtMillis).toBe(5_000)
    }),
  )

  it.effect("offers a continuation only while the goal is active", () =>
    Effect.gen(function* () {
      const goals = yield* makeMemory
      expect(yield* goals.continuation("thread")).toBeUndefined()
      yield* goals.create({ threadId: "thread", objective: "finish R1", budget: {} })
      expect(yield* goals.continuation("thread")).toContain("finish R1")
      yield* goals.complete({ threadId: "thread" })
      expect(yield* goals.continuation("thread")).toBeUndefined()
    }),
  )

  it("treats a goal with no budget as never exhausted", () => {
    expect(
      exhausted({
        threadId: "t",
        objective: "o",
        status: "active",
        budget: {},
        usage: { tokens: 10_000_000, elapsedMillis: 10_000_000, turns: 99 },
        startedAtMillis: 0,
        updatedAtMillis: 0,
      }),
    ).toBe(false)
  })
})
