import { expect, it } from "@effect/vitest"
import { ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Database } from "bun:sqlite"
import * as RoleToolkits from "@rika/coding-tools/agent-role-toolkits"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer, Random, Stream } from "effect"
import type { Tool, Toolkit } from "effect/unstable/ai"
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

const testLayer = (options: Parameters<typeof layer>[0]) => layer(options)

type RouteModel = ReturnType<typeof testExecutionRoute>["main"]

const withIdentity = (model: RouteModel, identity: string): RouteModel => ({
  ...model,
  registrationIdentity: identity as typeof model.registrationIdentity,
  candidates: model.candidates.map((candidate) =>
    Object.assign({}, candidate, { registrationIdentity: identity as typeof candidate.registrationIdentity }),
  ),
})

const routeWithIdentity = (rootIdentity: string, titleIdentity: string) => {
  const route = testExecutionRoute()
  return { ...route, main: withIdentity(route.main, rootIdentity), title: withIdentity(route.title, titleIdentity) }
}

interface StoredEvent {
  readonly _tag?: string
  readonly invocationId?: string
}

const readTreeEvents = (filename: string, rootRunId: string) => {
  const database = new Database(filename, { readonly: true })
  const rows = database
    .query<{ position: number; run_id: string; event_json: string }, [string]>(
      `SELECT i.position, e.run_id, e.event_json
       FROM baton_tree_event_index i
       JOIN baton_run_events e ON e.event_id = i.event_id
       WHERE i.root_run_id = ?
       ORDER BY i.position`,
    )
    .all(rootRunId)
    .map(({ position, run_id, event_json }) => ({
      position,
      runId: run_id,
      event: JSON.parse(event_json) as StoredEvent,
    }))
  database.close()
  return rows
}

const partText = (part: unknown): ReadonlyArray<string> => {
  const candidate = part as { readonly type?: string; readonly text?: string }
  return candidate.type === "text" && candidate.text !== undefined ? [candidate.text] : []
}

const promptText = (prompt: { readonly content?: ReadonlyArray<unknown> } | undefined): string =>
  (prompt?.content ?? [])
    .flatMap((message) => {
      const content = (message as { readonly content?: unknown }).content
      if (typeof content === "string") return [content]
      return Array.isArray(content) ? content.flatMap(partText) : []
    })
    .join("\n")

const assistantText = (units: ReadonlyArray<{ readonly content: unknown }>) =>
  units.flatMap((unit) => {
    const content = unit.content as { _tag?: string; role?: string; text?: string }
    return content._tag === "Entry" && content.role === "assistant" ? [content.text ?? ""] : []
  })

it.live(
  "starts the root turn without waiting for thread titling and still generates the title",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-title-nonblocking-${yield* Random.nextInt}.db`
      const rootFixture = yield* TestModel.make([TestModel.turn([TestModel.text("ROOT_ANSWER")])], {
        provider: "test",
        model: "test",
        registrationKey: "title-nonblocking-root",
      })
      // The title lane is slow: if titling gated the root, the root could not answer first.
      const titleFixture = yield* TestModel.make(
        [TestModel.turn([TestModel.text("Generated Title")], { delay: "3 seconds" })],
        { provider: "test", model: "test", registrationKey: "title-nonblocking-title" },
      )
      const { link, changes } = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({
              filename,
              modelServices: registryLayer(rootFixture, titleFixture),
              agentServices: () => agentServices,
            }),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const receipt = yield* gateway.startTurn({
            threadId: "thread-title-nonblocking",
            turnId: "turn-title-nonblocking",
            workspace: "/workspace",
            prompt: "answer immediately",
            executionRoute: routeWithIdentity("title-nonblocking-root", "title-nonblocking-title"),
            titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "answer immediately" },
          })
          return { link: receipt, changes: [...(yield* gateway.watchTurn(receipt).pipe(Stream.runCollect))] }
        }),
      )

      const rootEvents = readTreeEvents(filename, link.runId).filter((row) => row.runId === link.runId)
      const rootAttemptStarted = rootEvents.findIndex((row) => row.event._tag === "RunAttemptStarted")
      const childLinked = rootEvents.findIndex((row) => row.event._tag === "ChildLinked")
      // The defect: with titling admitted as an initial child, Baton withheld RunAttemptStarted
      // until the title child settled, so the root never ran and the user prompt was never sent.
      expect(rootAttemptStarted).toBeGreaterThanOrEqual(0)
      expect(rootAttemptStarted).toBeLessThan(childLinked)

      const last = changes.at(-1)
      expect(last?.state.status).toBe("completed")
      expect(last?.state.title?.text).toBe("Generated Title")
      const units = changes.flatMap((change) => (change._tag === "ProjectionSnapshot" ? change.units : change.upsert))
      expect(assistantText(units)).toContain("ROOT_ANSWER")
    }),
  20_000,
)

it.live(
  "cancelling a first turn while titling is in flight still delivered the user prompt and settles",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-title-cancel-${yield* Random.nextInt}.db`
      const rootFixture = yield* TestModel.make(
        [TestModel.turn([TestModel.text("ROOT_ANSWER")], { delay: "10 seconds" })],
        { provider: "test", model: "test", registrationKey: "title-cancel-root" },
      )
      const titleFixture = yield* TestModel.make(
        [TestModel.turn([TestModel.text("Generated Title")], { delay: "10 seconds" })],
        { provider: "test", model: "test", registrationKey: "title-cancel-title" },
      )
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({
              filename,
              modelServices: registryLayer(rootFixture, titleFixture),
              agentServices: () => agentServices,
            }),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const receipt = yield* gateway.startTurn({
            threadId: "thread-title-cancel",
            turnId: "turn-title-cancel",
            workspace: "/workspace",
            prompt: "the user prompt that must not be dropped",
            executionRoute: routeWithIdentity("title-cancel-root", "title-cancel-title"),
            titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "the user prompt" },
          })
          // Both lanes are slow, so this is the exact window in which the user cancels.
          // The root must reach the model without waiting for the 10s title lane.
          yield* rootFixture.awaitRequests(1).pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () => Effect.die("root model call did not start; thread titling is gating the user's turn"),
            }),
          )
          const rootRequests = yield* rootFixture.requests
          yield* gateway.cancelTurn(receipt, "Cancelled by Rika")
          const inspected = yield* gateway.inspectTurn(receipt)
          return { rootRequests, inspected }
        }),
      )
      // The defect: titling gated the root, so at cancel time the root had issued no model call
      // and the user's prompt was never sent. awaitRequests(1) above would never settle.
      expect(outcome.rootRequests.length).toBe(1)
      expect(promptText(outcome.rootRequests[0]?.prompt)).toContain("the user prompt that must not be dropped")
      expect(["cancelling", "cancelled"]).toContain(outcome.inspected.status)
    }),
  20_000,
)

it.live(
  "re-admits the same turn after a restart without duplicating the title child",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-title-restart-${yield* Random.nextInt}.db`
      const start = Effect.fn("titleRestart.start")(function* () {
        const rootFixture = yield* TestModel.make([TestModel.turn([TestModel.text("ROOT_ANSWER")])], {
          provider: "test",
          model: "test",
          registrationKey: "title-restart-root",
        })
        const titleFixture = yield* TestModel.make([TestModel.turn([TestModel.text("Generated Title")])], {
          provider: "test",
          model: "test",
          registrationKey: "title-restart-title",
        })
        const context = yield* Layer.build(
          testLayer({
            filename,
            modelServices: registryLayer(rootFixture, titleFixture),
            agentServices: () => agentServices,
          }),
        )
        const gateway = Context.get(context, ExecutionGateway.Service)
        return yield* gateway.startTurn({
          threadId: "thread-title-restart",
          turnId: "turn-title-restart",
          workspace: "/workspace",
          prompt: "restart safe prompt",
          executionRoute: routeWithIdentity("title-restart-root", "title-restart-title"),
          titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "restart safe prompt" },
        })
      })
      const first = yield* Effect.scoped(start())
      // A restart replays the same admission; spawn is keyed by idempotencyKey and must not fork a second title.
      const second = yield* Effect.scoped(start())

      expect(second.runId).toBe(first.runId)
      const linked = readTreeEvents(filename, first.runId).filter((row) => row.event._tag === "ChildLinked")
      expect(linked.length).toBe(1)
      expect(linked[0]?.event.invocationId).toBe("rika.thread-title")
    }),
  20_000,
)
