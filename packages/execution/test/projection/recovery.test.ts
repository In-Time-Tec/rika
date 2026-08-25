import { expect, it } from "@effect/vitest"
import { ModelRegistry } from "tenetkit"
import { TestModel } from "tenetkit/test"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"
import { Context, Effect, Layer, Random, Schema, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { memoryLayer as layer } from "../support/adapters"

const registryLayer = (...fixtures: ReadonlyArray<TestModel.Fixture>) =>
  ModelRegistry.layer(
    fixtures.map((fixture) => Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false })),
  )

const testLayer = (options: Parameters<typeof layer>[0]) => layer(options)

type RouteModel = ReturnType<typeof testExecutionRoute>["main"]
type PromptRequest = Pick<TestModel.Request, "prompt">

const withIdentity = (model: RouteModel, identity: string): RouteModel => ({
  ...model,
  registrationIdentity: modelRegistrationIdentity(identity),
  candidates: model.candidates.map((candidate) =>
    Object.assign({}, candidate, { registrationIdentity: modelRegistrationIdentity(identity) }),
  ),
})

const routeWithIdentity = (rootIdentity: string, titleIdentity: string) => {
  const route = testExecutionRoute()
  return { ...route, main: withIdentity(route.main, rootIdentity), title: withIdentity(route.title, titleIdentity) }
}

const requestText = (requests: ReadonlyArray<PromptRequest>): string =>
  requests.map((request) => JSON.stringify(request.prompt)).join("\n")

it.effect("keeps the plain prompt when structured prompt parts are empty", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        testLayer({ dataRoot: `/tmp/rika-empty-prompt-parts-${yield* Random.nextInt}.db` }),
      )
      const gateway = Context.get(context, ExecutionGateway.Service)
      const prepared = yield* gateway.prepareTurn({
        threadId: "thread-empty-parts",
        turnId: "turn-empty-parts",
        workspaceId: "/workspace",
        prompt: "plain text survives",
        promptParts: [],
        executionRoute: testExecutionRoute(),
      })
      const admission = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ prompt: Prompt.Prompt })))(
        prepared.rootAdmissionJson,
      )
      expect(requestText([{ prompt: admission.prompt }])).toContain("plain text survives")
    }),
  ),
)

it.live(
  "continues a thread so each in-memory turn carries the prior conversation",
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

      const context = yield* Layer.build(
        testLayer({
          dataRoot: filename,
          modelServices: registryLayer(rootFixture),
        }),
      )
      const gateway = Context.get(context, ExecutionGateway.Service)
      const turn = (turnId: string, prompt: string) =>
        Effect.gen(function* () {
          const receipt = yield* gateway.startTurn({
            threadId,
            turnId,
            workspaceId: "/workspace",
            prompt,
            executionRoute: routeWithIdentity("continuity-root", "continuity-root"),
          })
          yield* gateway.watchTurn(receipt).pipe(Stream.runCollect)
          seen.push(requestText(yield* rootFixture.requests))
        })

      yield* turn("turn-1", "first question")
      yield* turn("turn-2", "second question")
      yield* turn("turn-3", "third question")

      const third = seen.at(-1) ?? ""
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
                dataRoot: filename,
                modelServices: registryLayer(rootFixture, titleFixture),
              }),
            )
            const gateway = Context.get(context, ExecutionGateway.Service)
            const request: Parameters<typeof gateway.startTurn>[0] = titled
              ? {
                  threadId,
                  turnId,
                  workspaceId: "/workspace",
                  prompt,
                  executionRoute: routeWithIdentity("isolation-root", "isolation-title"),
                  titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: prompt },
                }
              : {
                  threadId,
                  turnId,
                  workspaceId: "/workspace",
                  prompt,
                  executionRoute: routeWithIdentity("isolation-root", "isolation-title"),
                }
            const receipt = yield* gateway.startTurn(request)
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
