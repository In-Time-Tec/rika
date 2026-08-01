import { expect, it } from "@effect/vitest"

import { Ids } from "@relayfx/sdk"
import { Deferred, Effect, Fiber, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"

import * as ExecutionBackend from "@rika/product/execution-service"

import { createFanOut, currentExecutionRoute } from "./current-execution-route"

import { fixture as testSupport } from "./execution-backend-fixture"
const { relayEvent, makeClient, provideBackend } = testSupport
it.effect("adapts fan-out, workflow, child, inspection, and steering operations", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient()
    const calls: Array<[string, unknown]> = []
    const fanOut = {
      fan_out_id: "fan-1",
      parent_execution_id: "execution:parent-1",
      state: "running",
      max_concurrency: 2,
      join: { _tag: "quorum", count: 1 },
      members: [
        { child_execution_id: "child:one", ordinal: 0, state: "completed", output: "done" },
        { child_execution_id: "child:two", ordinal: 1, state: "failed", error: "bad" },
      ],
    }
    const workflow = {
      execution_id: "workflow:run-1",
      pin: {
        workflow_definition_id: "rika:delivery:v1",
        workflow_definition_revision: 2,
        workflow_definition_digest: "digest",
      },
      status: "running",
      created_at: 10,
      updated_at: 20,
    }
    Object.assign(fixture.implementation.childRuns, {
      createFanOut: (input: unknown) => (calls.push(["createFanOut", input]), Effect.succeed(fanOut)),
      inspectFanOut: (input: unknown) => (calls.push(["inspectFanOut", input]), Effect.succeed({ fan_out: fanOut })),
      cancelFanOut: (input: unknown) => (calls.push(["cancelFanOut", input]), Effect.succeed({ fan_out: fanOut })),
      spawn: (input: unknown) => (calls.push(["child", input]), Effect.succeed({})),
    })
    Object.assign(fixture.implementation.workflows, {
      registerDefinition: (input: { definition: { name: string } }) =>
        Effect.succeed({
          record: { definition: input.definition, revision: 1, digest: `digest-${input.definition.name}` },
        }),
      startRun: (input: unknown) => (calls.push(["startWorkflow", input]), Effect.succeed(workflow)),
      inspectRun: (input: unknown) => (calls.push(["inspectWorkflow", input]), Effect.succeed(workflow)),
      cancelRun: (input: unknown) => (calls.push(["cancelWorkflow", input]), Effect.succeed(workflow)),
    })
    Object.assign(fixture.implementation.executions, {
      get: () =>
        Effect.succeed({
          status: "running",
          metadata: { rika_execution_route: currentExecutionRoute() },
        }),
      inspect: () =>
        Effect.succeed({
          status: "waiting",
          last_event_cursor: "last",
          waiting_on: [{ wait_id: "wait-1", mode: "external", created_at: 1 }],
          pending_tool_calls: [
            { tool_call_id: "call-1", tool_name: "bash", input: { command: "pwd" }, requested_at: 2 },
          ],
          child_runs: [{ child_execution_id: "child:one", status: "completed" }],
        }),
      steer: (input: unknown) => (calls.push(["steer", input]), Effect.succeed({})),
    })
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return {
        fan: yield* createFanOut(backend, {
          fanOutId: "fan-1",
          parentTurnId: "parent-1",
          children: [
            { childId: "one", prompt: "a", profile: "Oracle" },
            { childId: "two", prompt: "b" },
          ],
          maxConcurrency: 2,
          join: "quorum",
          quorum: 1,
          createdAt: 1,
        }),
        inspectedFan: yield* backend.inspectFanOut("fan-1"),
        cancelledFan: yield* backend.cancelFanOut("fan-1", 4, "stop"),
        registrations: yield* backend.registerWorkflows(),
        startedWorkflow: yield* backend.startWorkflow("delivery", "run-1", 2),
        inspectedWorkflow: yield* backend.inspectWorkflow("run-1"),
        cancelledWorkflow: yield* backend.cancelWorkflow("run-1"),
        child: yield* backend.invokeChild({
          parentTurnId: "parent-1",
          childId: "one",
          profile: "Task",
          prompt: "work",
        }),
        inspection: yield* backend.inspect("parent-1"),
        steer: yield* backend.steer("parent-1", "continue", "steer-parent-1"),
      }
    }).pipe(provideBackend(fixture.implementation))
    expect(result.fan).toMatchObject({ fanOutId: "fan-1", parentTurnId: "parent-1", join: "quorum" })
    expect(result.fan.members).toEqual([
      { childId: "one", ordinal: 0, state: "completed", output: "done" },
      { childId: "two", ordinal: 1, state: "failed", error: "bad" },
    ])
    expect(result.registrations.map((value) => value.name)).toEqual(["delivery", "research-synthesis"])
    expect(result.startedWorkflow).toMatchObject({ runId: "run-1", workflow: "delivery", revision: 2 })
    expect(result.child).toEqual({ parentTurnId: "parent-1", childId: "one", profile: "Task", type: "accepted" })
    expect(result.inspection).toMatchObject({ status: "waiting", lastCursor: "last" })
    expect(calls).toHaveLength(8)
  }),
)
it.effect("waits for the root execution to become steerable before sending steering", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient()
    let reads = 0
    const steering: Array<unknown> = []
    Object.assign(fixture.implementation.executions, {
      get: () =>
        Effect.sync(() => {
          reads += 1
          return reads === 1 ? undefined : { status: "running", metadata: {} }
        }),
      steer: (input: unknown) => Effect.sync(() => steering.push(input)),
    })
    const fiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* backend.steer("turn-race", "continue", "steer-turn-race")
      }).pipe(provideBackend(fixture.implementation)),
    )
    yield* TestClock.adjust("25 millis")
    yield* Fiber.join(fiber)
    expect(reads).toBe(2)
    expect(steering).toHaveLength(1)
  }),
)
it.effect("covers absent optional adapter results and payload fields", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient()
    const calls: Array<unknown> = []
    Object.assign(fixture.implementation.childRuns, {
      inspectFanOut: () => Effect.succeed({ fan_out: null }),
      cancelFanOut: (input: unknown) => {
        calls.push(input)
        return Effect.succeed({
          fan_out: {
            fan_out_id: "fan",
            parent_execution_id: "child:parent",
            state: "cancelled",
            max_concurrency: 1,
            join: { _tag: "all" },
            members: [],
          },
        })
      },
    })
    Object.assign(fixture.implementation.workflows, {
      inspectRun: () => Effect.void,
      cancelRun: () => Effect.void,
      startRun: (input: unknown) => {
        calls.push(input)
        return Effect.succeed({
          execution_id: "workflow:r",
          pin: {
            workflow_definition_id: "rika:research-synthesis:v1",
            workflow_definition_revision: 1,
            workflow_definition_digest: "d",
          },
          status: "queued",
          created_at: 1,
          updated_at: 1,
        })
      },
    })
    Object.assign(fixture.implementation.executions, { get: () => Effect.void })
    const values = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      return [
        yield* backend.inspectFanOut("missing"),
        yield* backend.cancelFanOut("fan", 1),
        yield* backend.startWorkflow("research-synthesis", "r"),
        yield* backend.inspectWorkflow("r"),
        yield* backend.cancelWorkflow("r"),
        yield* backend.inspect("missing"),
      ]
    }).pipe(provideBackend(fixture.implementation))
    expect(values[0]).toBeUndefined()
    expect(values[1]).toMatchObject({ parentTurnId: "child:parent", join: "all" })
    expect(values[3]).toBeUndefined()
    expect(values[4]).toBeUndefined()
    expect(values[5]).toBeUndefined()
    expect(calls).toContainEqual({ fan_out_id: "fan", cancelled_at: 1 })
  }),
)
it.effect("covers every join payload and child-prefixed execution identifiers", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({
      replayEvents: [relayEvent("model.output.delta", 1, [{ type: "text", text: "" }])],
    })
    const inputs: Array<unknown> = []
    Object.assign(fixture.implementation.childRuns, {
      createFanOut: (input: unknown) => {
        inputs.push(input)
        return Effect.succeed({
          fan_out_id: "fan",
          parent_execution_id: "execution:p",
          state: "running",
          max_concurrency: 1,
          join: { _tag: "all" },
          members: [],
        })
      },
    })
    Object.assign(fixture.implementation.executions, {
      get: () => Effect.succeed({ status: "running" }),
      inspect: () => Effect.succeed({ status: "running", waiting_on: [], pending_tool_calls: [], child_runs: [] }),
    })
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      for (const join of ["all", "first-success", "best-effort"] as const) {
        yield* createFanOut(backend, {
          fanOutId: `fan-${join}`,
          parentTurnId: "p",
          children: [],
          maxConcurrency: 1,
          join,
          createdAt: 1,
        })
      }
      yield* createFanOut(backend, {
        fanOutId: "fan-quorum-default",
        parentTurnId: "p",
        children: [],
        maxConcurrency: 1,
        join: "quorum",
        createdAt: 1,
      })
      return {
        replay: yield* backend.replay("child:already-prefixed", undefined, ExecutionBackend.executionReference),
        inspection: yield* backend.inspect("p"),
      }
    }).pipe(provideBackend(fixture.implementation))
    expect(inputs).toHaveLength(4)
    expect(result.replay.events[0]).not.toHaveProperty("text")
    expect(result.inspection).not.toHaveProperty("lastCursor")
  }),
)
it.effect("round-trips every inspected child execution identifier through execution operations", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient({ cancelStatus: "cancelled" })
    const childExecutionId = Ids.ChildExecutionId.make("execution:parent:child:Review:call-review")
    Object.assign(fixture.implementation.executions, {
      get: () => Effect.succeed({ status: "running" }),
      inspect: () =>
        Effect.succeed({
          status: "running",
          waiting_on: [],
          pending_tool_calls: [],
          child_runs: [{ child_execution_id: childExecutionId, status: "running" }],
        }),
    })
    const inspectedChildId = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      const inspection = yield* backend.inspect("parent")
      const childId = inspection?.children[0]?.executionId
      if (childId === undefined) return yield* Effect.die("Missing inspected child")
      yield* backend.replay(childId, undefined, ExecutionBackend.executionReference)
      if (backend.pageEvents === undefined) return yield* Effect.die("Missing event paging")
      yield* backend.pageEvents(childId, "forward", undefined, undefined, ExecutionBackend.executionReference)
      yield* backend.cancel(childId, ExecutionBackend.executionReference)
      return childId
    }).pipe(provideBackend(fixture.implementation))

    expect(inspectedChildId).toBe(childExecutionId)
    expect((yield* Ref.get(fixture.replays)).map((input) => input.execution_id)).toEqual([
      childExecutionId,
      childExecutionId,
    ])
    expect((yield* Ref.get(fixture.pages)).map((input) => input.execution_id)).toEqual([childExecutionId])
    expect((yield* Ref.get(fixture.cancellations)).map((input) => input.execution_id)).toEqual([childExecutionId])
  }),
)
it.effect("follows only the selected execution when the event scope is execution", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const rootExecutionId = Ids.ExecutionId.make("execution:parent")
      const childExecutionId = Ids.ChildExecutionId.make("execution:parent:child:Task:call-task")
      const followed = yield* Ref.make<ReadonlyArray<string>>([])
      Object.assign(fixture.implementation.executions, {
        inspect: (id: Ids.ExecutionId) =>
          Effect.succeed({
            status: "running",
            waiting_on: [],
            pending_tool_calls: [],
            child_runs: id === rootExecutionId ? [{ child_execution_id: childExecutionId, status: "running" }] : [],
          }),
        follow: (input: { readonly execution_id: Ids.ExecutionId }) =>
          Stream.fromEffect(Ref.update(followed, (executionIds) => [...executionIds, String(input.execution_id)])).pipe(
            Stream.concat(Stream.never),
          ),
      })

      const follower = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        if (backend.follow === undefined) return yield* Effect.die("Missing execution follow")
        return yield* Effect.forkChild(backend.follow("parent", undefined, undefined, undefined, "execution"))
      }).pipe(provideBackend(fixture.implementation))
      while ((yield* Ref.get(followed)).length === 0) yield* Effect.yieldNow
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow

      expect(yield* Ref.get(followed)).toEqual([rootExecutionId])
      yield* Fiber.interrupt(follower)
    }),
  ),
)
it.effect("launches each tree follow once when inspection and root events report the same child", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const rootExecutionId = Ids.ExecutionId.make("execution:parent")
      const childExecutionId = Ids.ChildExecutionId.make("execution:parent:child:Task:call-task")
      const subscriptions = yield* Ref.make<ReadonlyArray<string>>([])
      const finalizations = yield* Ref.make<ReadonlyArray<string>>([])
      const rootSubscribed = yield* Deferred.make<void>()
      const childSubscribed = yield* Deferred.make<void>()
      const spawned = {
        ...relayEvent("child_run.spawned", 1, undefined, { child_execution_id: childExecutionId }),
        execution_id: rootExecutionId,
        child_execution_id: childExecutionId,
      }
      Object.assign(fixture.implementation.executions, {
        inspect: (id: Ids.ExecutionId) =>
          Effect.succeed({
            status: "running",
            waiting_on: [],
            pending_tool_calls: [],
            child_runs: id === rootExecutionId ? [{ child_execution_id: childExecutionId, status: "running" }] : [],
          }),
        follow: (input: { readonly execution_id: Ids.ExecutionId }) => {
          const executionId = String(input.execution_id)
          return Stream.unwrap(
            Ref.update(subscriptions, (executionIds) => [...executionIds, executionId]).pipe(
              Effect.andThen(
                Deferred.succeed(executionId === rootExecutionId ? rootSubscribed : childSubscribed, undefined),
              ),
              Effect.as(
                executionId === rootExecutionId
                  ? Stream.concat(Stream.succeed({ _tag: "event" as const, event: spawned }), Stream.never)
                  : Stream.never,
              ),
            ),
          ).pipe(Stream.ensuring(Ref.update(finalizations, (executionIds) => [...executionIds, executionId])))
        },
      })

      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        if (backend.follow === undefined) return yield* Effect.die("Missing execution follow")
        const follower = yield* Effect.forkChild(backend.follow("parent", undefined))
        yield* Deferred.await(rootSubscribed)
        yield* Deferred.await(childSubscribed)

        expect(yield* Ref.get(subscriptions)).toEqual([rootExecutionId, childExecutionId])
        yield* Fiber.interrupt(follower)
        expect((yield* Ref.get(finalizations)).toSorted()).toEqual([rootExecutionId, childExecutionId].toSorted())
      }).pipe(provideBackend(fixture.implementation))
    }),
  ),
)
it.effect("keeps the root waiting when a child reaches a permission request", () =>
  Effect.gen(function* () {
    const fixture = yield* makeClient()
    const rootExecutionId = Ids.ExecutionId.make("execution:parent")
    const childExecutionId = Ids.ChildExecutionId.make("execution:parent:child:Review:call-review")
    const spawned = {
      ...relayEvent("child_run.spawned", 1, undefined, { child_execution_id: childExecutionId }),
      execution_id: rootExecutionId,
      child_execution_id: childExecutionId,
    }
    const requested = {
      ...relayEvent("permission.ask.requested", 1, undefined, {
        wait_id: "wait-child",
        tool_call_id: "call-child",
        tool_name: "read",
      }),
      execution_id: Ids.ExecutionId.make(childExecutionId),
    }
    Object.assign(fixture.implementation.executions, {
      inspect: (id: Ids.ExecutionId) =>
        Effect.succeed(
          id === rootExecutionId
            ? {
                status: "waiting",
                waiting_on: [],
                pending_tool_calls: [],
                child_runs: [{ child_execution_id: childExecutionId, status: "waiting" }],
              }
            : {
                status: "waiting",
                waiting_on: [
                  {
                    wait_id: "wait-child",
                    execution_id: childExecutionId,
                    mode: "reply",
                    state: "open",
                    metadata: {},
                    created_at: 2,
                  },
                ],
                pending_tool_calls: [],
                child_runs: [],
              },
        ),
      follow: (input: { readonly execution_id: Ids.ExecutionId }) =>
        Stream.fromIterable(
          (input.execution_id === rootExecutionId ? [spawned] : [requested]).map((event) => ({
            _tag: "event" as const,
            event,
          })),
        ),
    })
    const seen: Array<string> = []
    const result = yield* Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      if (backend.follow === undefined) return yield* Effect.die("Missing execution follow")
      return yield* backend.follow("parent", undefined, (item) => seen.push(item.type))
    }).pipe(provideBackend(fixture.implementation))

    expect(result.status).toBe("waiting")
    expect(seen).toEqual(["child_run.spawned", "permission.ask.requested"])
    expect(yield* Ref.get(fixture.cancellations)).toEqual([])
  }),
)
