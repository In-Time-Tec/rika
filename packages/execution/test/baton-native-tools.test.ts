import { expect, it } from "@effect/vitest"
import { ModelRegistry, Pins, SandboxExecutor } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Database } from "bun:sqlite"
import * as RoleToolkits from "@rika/tools/agent-role-toolkits"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Context, Deferred, Effect, Layer, Random, Ref, Schema, Stream } from "effect"
import { type Tool, type Toolkit } from "effect/unstable/ai"
import { layer } from "../src/baton-execution"

const registryLayer = (...fixtures: ReadonlyArray<TestModel.Fixture>) =>
  ModelRegistry.layer(
    fixtures.map((fixture) => Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false })),
  )

const stubHandlers = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>) =>
  toolkit.toLayer(
    Object.fromEntries(Object.keys(toolkit.tools).map((name) => [name, () => Effect.succeed({})])) as never,
  )

const agentServices = Layer.mergeAll(stubHandlers(RoleToolkits.root), stubHandlers(RoleToolkits.readThread))

const sandbox = SandboxExecutor.makeTest(() => Effect.die(new Error("unexpected Program execution")), {
  language: "javascript",
  implementation: "rika-native-tools-test-sandbox",
  version: "1",
  memoryBytes: 1024,
  stackBytes: 1024,
})

const testLayer = (options: Parameters<typeof layer>[0]) =>
  layer(options).pipe(Layer.provide(Layer.succeed(SandboxExecutor.SandboxExecutor, sandbox)))

const routeWithIdentity = (identity: string) => {
  const route = testExecutionRoute()
  return {
    ...route,
    main: {
      ...route.main,
      registrationIdentity: identity as typeof route.main.registrationIdentity,
      candidates: route.main.candidates.map((candidate) =>
        Object.assign({}, candidate, { registrationIdentity: identity as typeof candidate.registrationIdentity }),
      ),
    },
  }
}

const promptJson = Schema.encodeSync(Schema.UnknownFromJsonString)

interface StoredEvent {
  readonly _tag?: string
  readonly invocationId?: string
  readonly childRunId?: string
  readonly fanOutId?: string
  readonly part?: { readonly type?: string; readonly name?: string }
}

const readTreeEvents = (filename: string, rootRunId: string) => {
  const database = new Database(filename, { readonly: true })
  const rows = database
    .query<{ position: number; event_json: string }, [string]>(
      `SELECT i.position, e.event_json
       FROM baton_tree_event_index i
       JOIN baton_run_events e ON e.event_id = i.event_id
       WHERE i.root_run_id = ?
       ORDER BY i.position`,
    )
    .all(rootRunId)
    .map(({ position, event_json }) => ({ position, event: JSON.parse(event_json) as StoredEvent }))
  database.close()
  return rows
}

const readFanOutMembers = (filename: string, groupId: string) => {
  const database = new Database(filename, { readonly: true })
  const rows = database
    .query<{ member_key: string; child_run_id: string; status: string }, [string]>(
      `SELECT member_key, child_run_id, status
       FROM baton_fan_out_members
       WHERE fan_out_id = ?
       ORDER BY ordinal`,
    )
    .all(groupId)
  database.close()
  return rows
}

it.live(
  "starts one durable child group before awaiting its stable semantic children",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-native-child-group-${yield* Random.nextInt}.db`
      const awaitParameters = { groupId: "pending" }
      const rootFixture = yield* TestModel.make(
        [
          TestModel.turn(
            [
              TestModel.toolCall(
                "start_child_group",
                {
                  concurrency: 2,
                  members: [
                    { key: "research", selection: "Oracle", prompt: "analyze the evidence" },
                    { key: "implementation", selection: "Librarian", prompt: "research the implementation" },
                  ],
                },
                { id: "group-call" },
              ),
            ],
            { delay: "50 millis" },
          ),
          TestModel.turn([TestModel.toolCall("await_child_group", awaitParameters, { id: "await-group-call" })]),
          TestModel.turn([TestModel.text("root report")]),
        ],
        { provider: "test", model: "test", registrationKey: "native-child-group-root" },
      )
      const childFixture = yield* TestModel.make(
        [TestModel.turn([TestModel.text("oracle report")]), TestModel.turn([TestModel.text("librarian report")])],
        { provider: "test", model: "test", registrationKey: "test" },
      )
      const link = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({
              filename,
              modelServices: registryLayer(rootFixture, childFixture),
              agentServices: () => agentServices,
            }),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const receipt = yield* gateway.startTurn({
            threadId: "thread-native-child-group",
            turnId: "turn-native-child-group",
            workspace: "/workspace",
            prompt: "use independent children",
            executionRoute: routeWithIdentity("native-child-group-root"),
          })
          awaitParameters.groupId = `fanout_${Pins.digest([
            receipt.runId,
            `child-group:${receipt.runId}:group-call`,
          ]).slice(0, 48)}`
          yield* gateway.watchTurn(receipt).pipe(Stream.runDrain)
          return receipt
        }),
      )
      const events = readTreeEvents(filename, link.runId)
      const childLinks = events.filter(({ event }) => event._tag === "ChildLinked")
      const awaitEvent = events.find(
        ({ event }) =>
          event._tag === "ModelPart" && event.part?.type === "tool-call" && event.part.name === "await_child_group",
      )
      expect(awaitEvent).toBeDefined()
      expect(childLinks).toHaveLength(2)
      expect(childLinks.every(({ position }) => position < awaitEvent!.position)).toBe(true)
      expect(childLinks.map(({ event }) => event.invocationId).toSorted()).toEqual([
        `${awaitParameters.groupId}:implementation`,
        `${awaitParameters.groupId}:research`,
      ])
      expect(childLinks.map(({ event }) => event.childRunId).toSorted()).toEqual([
        `${awaitParameters.groupId}_0`,
        `${awaitParameters.groupId}_1`,
      ])
      expect(
        events.some(
          ({ position, event }) =>
            event._tag === "FanOutAdmitted" &&
            event.fanOutId === awaitParameters.groupId &&
            position < awaitEvent!.position,
        ),
      ).toBe(true)
      expect(
        events.some(({ event }) => event._tag === "FanOutJoined" && event.fanOutId === awaitParameters.groupId),
      ).toBe(true)
      expect(readFanOutMembers(filename, awaitParameters.groupId)).toEqual([
        { member_key: "research", child_run_id: `${awaitParameters.groupId}_0`, status: "succeeded" },
        { member_key: "implementation", child_run_id: `${awaitParameters.groupId}_1`, status: "succeeded" },
      ])
      const rootRequests = yield* rootFixture.requests
      expect(rootRequests).toHaveLength(3)
      expect(promptJson(rootRequests[1]?.prompt)).toContain(awaitParameters.groupId)
      expect(promptJson(rootRequests[2]?.prompt)).toContain("oracle report")
      expect(promptJson(rootRequests[2]?.prompt)).toContain("librarian report")
      expect(yield* childFixture.requests).toHaveLength(2)
    }),
  60_000,
)

it.live(
  "overlaps read-only tools while keeping workspace mutations as exclusive barriers",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-native-tool-scheduling-${yield* Random.nextInt}.db`
      const trace = yield* Ref.make<ReadonlyArray<string>>([])
      const readCount = yield* Ref.make(0)
      const readsOverlapped = yield* Deferred.make<void>()
      const record = (event: string) => Ref.update(trace, (events) => [...events, event])
      const handlers = Object.fromEntries(
        Object.keys(RoleToolkits.root.tools).map((name) => [
          name,
          () => Effect.succeed({ text: name, truncated: false }),
        ]),
      ) as Record<string, (input: { readonly path: string }) => Effect.Effect<{ text: string; truncated: false }>>
      handlers.read = ({ path }) =>
        Effect.gen(function* () {
          yield* record(`read-start:${path}`)
          const active = yield* Ref.updateAndGet(readCount, (count) => count + 1)
          if (active === 2) yield* Deferred.succeed(readsOverlapped, undefined)
          yield* Deferred.await(readsOverlapped)
          yield* record(`read-end:${path}`)
          yield* Ref.update(readCount, (count) => count - 1)
          return { text: path, truncated: false as const }
        })
      handlers.edit = ({ path }) =>
        Effect.gen(function* () {
          yield* record(`write-start:${path}`)
          yield* Effect.yieldNow
          yield* record(`write-end:${path}`)
          return { text: path, truncated: false as const }
        })
      const schedulingServices = Layer.mergeAll(
        RoleToolkits.root.toLayer(handlers as never),
        stubHandlers(RoleToolkits.readThread),
      )
      const fixture = yield* TestModel.make(
        [
          TestModel.turn([
            TestModel.toolCall("read", { path: "first.ts" }, { id: "read-first" }),
            TestModel.toolCall("read", { path: "second.ts" }, { id: "read-second" }),
            TestModel.toolCall("edit", { path: "first.ts", old_str: "old", new_str: "first" }, { id: "write-first" }),
            TestModel.toolCall(
              "edit",
              { path: "second.ts", old_str: "old", new_str: "second" },
              { id: "write-second" },
            ),
          ]),
          TestModel.turn([TestModel.text("scheduled")]),
        ],
        { provider: "test", model: "test", registrationKey: "native-tool-scheduling-route" },
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({
              filename,
              modelServices: registryLayer(fixture),
              agentServices: () => schedulingServices,
            }),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const receipt = yield* gateway.startTurn({
            threadId: "thread-native-tool-scheduling",
            turnId: "turn-native-tool-scheduling",
            workspace: "/workspace",
            prompt: "schedule the tools",
            executionRoute: routeWithIdentity("native-tool-scheduling-route"),
          })
          yield* gateway.watchTurn(receipt).pipe(Stream.runDrain)
        }),
      )
      const events = yield* Ref.get(trace)
      const firstReadEnd = Math.min(events.indexOf("read-end:first.ts"), events.indexOf("read-end:second.ts"))
      expect(events.indexOf("read-start:first.ts")).toBeLessThan(firstReadEnd)
      expect(events.indexOf("read-start:second.ts")).toBeLessThan(firstReadEnd)
      expect(events.filter((event) => event.startsWith("write-"))).toEqual([
        "write-start:first.ts",
        "write-end:first.ts",
        "write-start:second.ts",
        "write-end:second.ts",
      ])
      expect(events.indexOf("write-start:first.ts")).toBeGreaterThan(events.indexOf("read-end:first.ts"))
      expect(events.indexOf("write-start:first.ts")).toBeGreaterThan(events.indexOf("read-end:second.ts"))
      expect(yield* fixture.requests).toHaveLength(2)
    }),
  60_000,
)
