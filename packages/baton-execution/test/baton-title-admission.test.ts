import { expect, it } from "@effect/vitest"
import { ModelRegistry, Response as AiResponse } from "tenetkit"
import { TestModel } from "tenetkit/test"
import { Database } from "bun:sqlite"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import type { Change } from "@rika/product/execution-projection"
import { Context, Effect, Layer, Random, Stream } from "effect"
import { layer } from "../src/baton-execution"

const registryLayer = (...fixtures: ReadonlyArray<TestModel.Fixture>) =>
  ModelRegistry.layer(
    fixtures.map((fixture) => Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false })),
  )

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

const projectionChanges = (events: ReadonlyArray<ExecutionGateway.ModelPreviewEvent | Change>): ReadonlyArray<Change> =>
  events.filter((event): event is Change => event._tag !== "ModelPreview" && event._tag !== "ModelPreviewCleared")

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
        [
          TestModel.turn([TestModel.text("Generated Title")], {
            delay: "3 seconds",
            usage: AiResponse.Usage.make({
              inputTokens: { total: 5, uncached: 5, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 3, text: 3, reasoning: undefined },
            }),
          }),
          TestModel.turn([TestModel.text("Generated Title")]),
        ],
        { provider: "test", model: "test", registrationKey: "title-nonblocking-title" },
      )
      const { link, changes } = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({
              filename,
              modelServices: registryLayer(rootFixture, titleFixture),
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
          return {
            link: receipt,
            changes: projectionChanges([...(yield* gateway.watchTurn(receipt).pipe(Stream.runCollect))]),
          }
        }),
      )

      const rootEvents = readTreeEvents(filename, link.runId).filter((row) => row.runId === link.runId)
      expect(rootEvents.some((row) => row.event._tag === "RunAttemptStarted")).toBe(true)
      expect(rootEvents.some((row) => row.event._tag === "ChildLinked")).toBe(false)

      expect(link.titleRunId).toBe(`${link.runId}:title`)
      const rootCompletedBeforeTitle = changes.find(
        (change) => change.state.status === "completed" && change.state.title === undefined,
      )
      expect(rootCompletedBeforeTitle?.state.usage.sourceComplete).toBe(false)
      const last = changes.at(-1)
      expect(last?.state.status).toBe("completed")
      expect(last?.state.title?.text).toBe("Generated Title")
      expect(last?.state.usage.sourceComplete).toBe(true)
      expect(last?.state.usage.tokens).toEqual(
        expect.objectContaining({
          total: 8,
          input: expect.objectContaining({ total: 5 }),
          output: expect.objectContaining({ total: 3 }),
        }),
      )
      const units = changes.flatMap((change) => (change._tag === "ProjectionSnapshot" ? change.units : change.upsert))
      expect(assistantText(units)).toContain("ROOT_ANSWER")
    }),
  20_000,
)

it.live(
  "projects a completed title while the root turn is still running",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-title-first-${yield* Random.nextInt}.db`
      const rootFixture = yield* TestModel.make(
        [TestModel.turn([TestModel.text("ROOT_ANSWER")], { delay: "3 seconds" })],
        { provider: "test", model: "test", registrationKey: "title-first-root" },
      )
      const titleFixture = yield* TestModel.make([TestModel.turn([TestModel.text("Generated Title")])], {
        provider: "test",
        model: "test",
        registrationKey: "title-first-title",
      })
      const changes = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({
              filename,
              modelServices: registryLayer(rootFixture, titleFixture),
            }),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const receipt = yield* gateway.startTurn({
            threadId: "thread-title-first",
            turnId: "turn-title-first",
            workspace: "/workspace",
            prompt: "keep the root running",
            executionRoute: routeWithIdentity("title-first-root", "title-first-title"),
            titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "keep the root running" },
          })
          return projectionChanges([...(yield* gateway.watchTurn(receipt).pipe(Stream.runCollect))])
        }),
      )

      const titleWhileRunning = changes.find(
        (change) => change.state.title?.text === "Generated Title" && change.state.status === "running",
      )
      expect(titleWhileRunning?.state.usage.sourceComplete).toBe(false)
      expect(changes.at(-1)?.state.status).toBe("completed")
      expect(changes.at(-1)?.state.usage.sourceComplete).toBe(true)
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
          // The root must reach the model without waiting for the 30s title lane.
          yield* rootFixture.awaitRequests(1).pipe(
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () => Effect.die("root model call did not start; thread titling is gating the user's turn"),
            }),
          )
          const rootRequests = yield* rootFixture.requests
          yield* gateway.cancelTurn(receipt, "Cancelled by user")
          const inspected = yield* gateway.inspectTurn(receipt)
          const changes = projectionChanges([...(yield* gateway.watchTurn(receipt).pipe(Stream.runCollect))])
          return { rootRequests, inspected, changes }
        }),
      )
      // The defect: titling gated the root, so at cancel time the root had issued no model call
      // and the user's prompt was never sent. awaitRequests(1) above would never settle.
      expect(outcome.rootRequests.length).toBe(1)
      expect(promptText(outcome.rootRequests[0]?.prompt)).toContain("the user prompt that must not be dropped")
      expect(["cancelling", "cancelled"]).toContain(outcome.inspected.status)
      const cancellationNotice = outcome.changes
        .flatMap((change) => (change._tag === "ProjectionSnapshot" ? change.units : change.upsert))
        .find(
          (unit) =>
            unit.content._tag === "Block" &&
            unit.content.block._tag === "Notification" &&
            unit.content.block.title === "Cancellation requested",
        )
      expect(cancellationNotice).toBeUndefined()
    }),
  45_000,
)

it.live(
  "keeps a completed title out of the next root model request",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-title-isolation-${yield* Random.nextInt}.db`
      const rootFixture = yield* TestModel.make(
        [
          TestModel.turn([TestModel.text("FIRST_ANSWER")]),
          TestModel.turn([TestModel.text("SECOND_ANSWER")]),
          TestModel.turn([TestModel.text("UNUSED_ANSWER")]),
        ],
        { provider: "test", model: "test", registrationKey: "title-isolation-root" },
      )
      const titleFixture = yield* TestModel.make([TestModel.turn([TestModel.text("Generated Title")])], {
        provider: "test",
        model: "test",
        registrationKey: "title-isolation-title",
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({
              filename,
              modelServices: registryLayer(rootFixture, titleFixture),
            }),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const route = routeWithIdentity("title-isolation-root", "title-isolation-title")
          const first = yield* gateway.startTurn({
            threadId: "thread-title-isolation",
            turnId: "turn-title-isolation-first",
            workspace: "/workspace",
            prompt: "first request",
            executionRoute: route,
            titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "first request" },
          })
          yield* gateway.watchTurn(first).pipe(Stream.runDrain)
          const second = yield* gateway.startTurn({
            threadId: "thread-title-isolation",
            turnId: "turn-title-isolation-second",
            workspace: "/workspace",
            prompt: "second request",
            executionRoute: route,
          })
          yield* gateway.watchTurn(second).pipe(Stream.runDrain)
        }),
      )
      const requests = yield* rootFixture.requests
      expect(requests).toHaveLength(2)
      const secondPrompt = promptText(requests[1]?.prompt)
      expect(secondPrompt).toContain("second request")
      expect(secondPrompt).not.toContain("Child run")
      expect(secondPrompt).not.toContain("Generated Title")
    }),
  20_000,
)

it.live(
  "settles the projection when a recorded title run is unavailable",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-title-missing-${yield* Random.nextInt}.db`
      const rootFixture = yield* TestModel.make([TestModel.turn([TestModel.text("ROOT_ANSWER")])], {
        provider: "test",
        model: "test",
        registrationKey: "title-missing-root",
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({
              filename,
              modelServices: registryLayer(rootFixture),
            }),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const receipt = yield* gateway.startTurn({
            threadId: "thread-title-missing",
            turnId: "turn-title-missing",
            workspace: "/workspace",
            prompt: "title run disappeared",
            executionRoute: routeWithIdentity("title-missing-root", "title-missing-title"),
          })
          const changes = projectionChanges([
            ...(yield* gateway.watchTurn({ ...receipt, titleRunId: "missing-title-run" }).pipe(Stream.runCollect)),
          ])
          expect(changes.at(-1)?.state.status).toBe("completed")
          expect(changes.at(-1)?.state.title).toBeUndefined()
          expect(changes.at(-1)?.state.usage.sourceComplete).toBe(true)
        }),
      )
    }),
  20_000,
)

it.live(
  "re-admits the same turn after a restart without duplicating the title run",
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
      const second = yield* Effect.scoped(start())

      expect(second.runId).toBe(first.runId)
      const database = new Database(filename, { readonly: true })
      const titleRuns = database
        .query<
          { run_id: string; parent_run_id: string | null },
          [string]
        >("SELECT run_id, parent_run_id FROM baton_runs WHERE run_id = ?")
        .all(`${first.runId}:title`)
      const accepted = database
        .query<
          { count: number },
          [string]
        >("SELECT COUNT(*) AS count FROM baton_run_events WHERE run_id = ? AND json_extract(event_json, '$._tag') = 'RunAccepted'")
        .get(`${first.runId}:title`)
      database.close()
      expect(titleRuns).toEqual([{ run_id: `${first.runId}:title`, parent_run_id: null }])
      expect(accepted?.count).toBe(1)
    }),
  20_000,
)
