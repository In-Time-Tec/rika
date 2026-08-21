import { expect, it } from "@effect/vitest"
import { ModelRegistry, Response as AiResponse } from "tenetkit"
import { TestModel } from "tenetkit/test"
import { Runtime } from "tenetkit/runtime"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import type { Change } from "@rika/product/execution-projection"
import { Context, Effect, Layer, Random, Stream } from "effect"
import { sqliteLayer as layer } from "./test-adapters"

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

const readTreeEvents = (runtime: Runtime.Interface, rootRunId: string) =>
  runtime.treeHistory({ rootRunId, limit: 1_000 }).pipe(Effect.map(({ events }) => events))

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
      const filename = `/tmp/rika-tenetkit-title-nonblocking-${yield* Random.nextInt}.db`
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
      const { link, changes, rootEvents } = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            testLayer({
              filename,
              modelServices: registryLayer(rootFixture, titleFixture),
            }),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const runtime = Context.get(context, Runtime.Runtime)
          const receipt = yield* gateway.startTurn({
            threadId: "thread-title-nonblocking",
            turnId: "turn-title-nonblocking",
            workspaceId: "/workspace",
            prompt: "answer immediately",
            executionRoute: routeWithIdentity("title-nonblocking-root", "title-nonblocking-title"),
            titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "answer immediately" },
          })
          const projected = projectionChanges([...(yield* gateway.watchTurn(receipt).pipe(Stream.runCollect))])
          return { link: receipt, changes: projected, rootEvents: yield* readTreeEvents(runtime, receipt.runId) }
        }),
      )

      const rootRunEvents = rootEvents.filter((row) => row.runId === link.runId)
      expect(rootRunEvents.some((row) => row.event._tag === "RunAttemptStarted")).toBe(true)
      expect(rootRunEvents.some((row) => row.event._tag === "ChildLinked")).toBe(false)

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
      const filename = `/tmp/rika-tenetkit-title-first-${yield* Random.nextInt}.db`
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
            workspaceId: "/workspace",
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
      const filename = `/tmp/rika-tenetkit-title-cancel-${yield* Random.nextInt}.db`
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
            workspaceId: "/workspace",
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
      const filename = `/tmp/rika-tenetkit-title-isolation-${yield* Random.nextInt}.db`
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
            workspaceId: "/workspace",
            prompt: "first request",
            executionRoute: route,
            titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "first request" },
          })
          yield* gateway.watchTurn(first).pipe(Stream.runDrain)
          const second = yield* gateway.startTurn({
            threadId: "thread-title-isolation",
            turnId: "turn-title-isolation-second",
            workspaceId: "/workspace",
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
      const filename = `/tmp/rika-tenetkit-title-missing-${yield* Random.nextInt}.db`
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
            workspaceId: "/workspace",
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
      const filename = `/tmp/rika-tenetkit-title-restart-${yield* Random.nextInt}.db`
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
        const runtime = Context.get(context, Runtime.Runtime)
        const receipt = yield* gateway.startTurn({
          threadId: "thread-title-restart",
          turnId: "turn-title-restart",
          workspaceId: "/workspace",
          prompt: "restart safe prompt",
          executionRoute: routeWithIdentity("title-restart-root", "title-restart-title"),
          titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "restart safe prompt" },
        })
        const titleRunId = receipt.titleRunId ?? (yield* Effect.die("title run identity is unavailable"))
        return {
          receipt,
          title: yield* runtime.inspect(titleRunId),
          accepted: (yield* runtime.history({ runId: titleRunId, limit: 100 })).filter(
            (event) => event._tag === "RunAccepted",
          ),
        }
      })
      const first = yield* Effect.scoped(start())
      const second = yield* Effect.scoped(start())

      expect(second.receipt.runId).toBe(first.receipt.runId)
      expect(second.title).toMatchObject({ runId: `${first.receipt.runId}:title`, depth: 0 })
      expect(second.title.parentRunId).toBeUndefined()
      expect(second.accepted).toHaveLength(1)
    }),
  20_000,
)
