import { expect, it } from "@effect/vitest"
import { ModelRegistry } from "tenetkit"
import { TestModel } from "tenetkit/test"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
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

const partText = (part: unknown): ReadonlyArray<string> => {
  const candidate = part as { readonly type?: string; readonly text?: string }
  return candidate.type === "text" && candidate.text !== undefined ? [candidate.text] : []
}

const messageText = (message: unknown): ReadonlyArray<string> => {
  const content = (message as { readonly content?: unknown }).content
  if (typeof content === "string") return [content]
  return Array.isArray(content) ? content.flatMap(partText) : []
}

/** Every text part the model actually received, so an assertion reads model context, not a wire shape. */
const requestText = (requests: ReadonlyArray<unknown>): string =>
  requests
    .flatMap((request) => {
      const prompt = (request as { readonly prompt?: { readonly content?: ReadonlyArray<unknown> } }).prompt
      return (prompt?.content ?? []).flatMap(messageText)
    })
    .join("\n")

it.live(
  "continues a thread so each turn carries the prior conversation",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-thread-continuity-${yield* Random.nextInt}.db`
      const threadId = "thread-continuity"
      const seen: Array<string> = []
      const rootFixture = yield* TestModel.make(
        [
          TestModel.turn([TestModel.text("ANSWER_ONE")]),
          TestModel.turn([TestModel.text("ANSWER_TWO")]),
          TestModel.turn([TestModel.text("ANSWER_THREE")]),
        ],
        { provider: "test", model: "test", registrationKey: "continuity-root" },
      )

      const turn = (turnId: string, prompt: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              testLayer({
                filename,
                modelServices: registryLayer(rootFixture),
              }),
            )
            const gateway = Context.get(context, ExecutionGateway.Service)
            const receipt = yield* gateway.startTurn({
              threadId,
              turnId,
              workspace: "/workspace",
              prompt,
              executionRoute: routeWithIdentity("continuity-root", "continuity-root"),
            })
            yield* gateway.watchTurn(receipt).pipe(Stream.runCollect)
            seen.push(requestText(yield* rootFixture.requests))
          }),
        )

      // Each turn opens its own gateway scope, so turns two and three cross a process boundary.
      yield* turn("turn-1", "first question")
      yield* turn("turn-2", "second question")
      yield* turn("turn-3", "third question")

      const third = seen.at(-1) ?? ""
      // The defect: every turn started a new Run with an empty Chat, so the model never saw
      // earlier turns and answered as if the thread had just begun.
      expect(third).toContain("first question")
      expect(third).toContain("ANSWER_ONE")
      expect(third).toContain("second question")
      expect(third).toContain("ANSWER_TWO")
      expect(third).toContain("third question")
    }),
  30_000,
)

it.live(
  "keeps the title lane out of the thread conversation",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-thread-title-isolation-${yield* Random.nextInt}.db`
      const threadId = "thread-title-isolation"
      const rootFixture = yield* TestModel.make(
        [TestModel.turn([TestModel.text("ANSWER_ONE")]), TestModel.turn([TestModel.text("ANSWER_TWO")])],
        { provider: "test", model: "test", registrationKey: "isolation-root" },
      )
      const titleFixture = yield* TestModel.make([TestModel.turn([TestModel.text("Generated Title")])], {
        provider: "test",
        model: "test",
        registrationKey: "isolation-title",
      })

      const turn = (turnId: string, prompt: string, titled: boolean) =>
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              testLayer({
                filename,
                modelServices: registryLayer(rootFixture, titleFixture),
              }),
            )
            const gateway = Context.get(context, ExecutionGateway.Service)
            const receipt = yield* gateway.startTurn({
              threadId,
              turnId,
              workspace: "/workspace",
              prompt,
              executionRoute: routeWithIdentity("isolation-root", "isolation-title"),
              ...(titled ? { titleIntent: { _tag: "GenerateThreadTitle" as const, expectedTitle: prompt } } : {}),
            })
            yield* gateway.watchTurn(receipt).pipe(Stream.runCollect)
          }),
        )

      yield* turn("turn-1", "first question", false)
      // Titling runs on the second turn, after the thread already has a conversation to leak.
      yield* turn("turn-2", "second question", true)

      const titleRequests = requestText(yield* titleFixture.requests)
      // A subagent works in isolation: sharing the thread's session identity would hand the
      // whole conversation to a lane that only needs to name it.
      expect(titleRequests).toContain("second question")
      expect(titleRequests).not.toContain("ANSWER_ONE")
      expect(titleRequests).not.toContain("first question")
    }),
  30_000,
)
