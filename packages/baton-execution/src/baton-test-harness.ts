import { AiError, ModelRegistry, Response as AiResponse } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import type * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { ChildRuns } from "@batonfx/runtime"
import { Context, Effect, Layer, Scope, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"

export type Profile =
  | "Root"
  | "Title"
  | "Compaction"
  | "Oracle"
  | "Librarian"
  | "Painter"
  | "ReadThread"
  | "Review"
  | "Surgeon"
  | "Task"

export type Step = TestModel.Step
export type Part = TestModel.Part

export interface Lane {
  readonly profile?: Profile
  readonly steps: ReadonlyArray<Step>
}

const profiles: ReadonlyArray<Profile> = [
  "Root",
  "Title",
  "Compaction",
  "Oracle",
  "Librarian",
  "Painter",
  "ReadThread",
  "Review",
  "Surgeon",
  "Task",
]

const usage = (input: { readonly inputTokens?: number; readonly outputTokens?: number }) =>
  AiResponse.Usage.make({
    inputTokens: {
      uncached: input.inputTokens,
      total: input.inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: input.outputTokens, text: input.outputTokens, reasoning: undefined },
  })

export const step = {
  text: (value: string, delayMillis?: number): Step =>
    TestModel.turn([TestModel.text(value)], delayMillis === undefined ? {} : { delay: `${delayMillis} millis` }),
  turn: (
    parts: ReadonlyArray<Part>,
    options: { readonly delayMillis?: number; readonly inputTokens?: number; readonly outputTokens?: number } = {},
  ): Step =>
    TestModel.turn(parts, {
      ...(options.delayMillis === undefined ? {} : { delay: `${options.delayMillis} millis` }),
      ...(options.inputTokens === undefined && options.outputTokens === undefined ? {} : { usage: usage(options) }),
    }),
  part: (value: string): Part => TestModel.text(value),
  reasoning: (value: string): Part => TestModel.reasoning(value),
  tool: (name: string, params: unknown, id: string): Part => TestModel.toolCall(name, params, { id }),
  runChild: (selection: string, prompt: string, id: string): Part =>
    TestModel.toolCall("run_child", { selection, prompt }, { id }),
  startChildGroup: (
    members: ReadonlyArray<{ readonly key: string; readonly selection: string; readonly prompt: string }>,
    options: { readonly id: string; readonly concurrency?: number },
  ): Part =>
    TestModel.toolCall(
      "start_child_group",
      { members, concurrency: options.concurrency ?? members.length },
      { id: options.id },
    ),
  awaitChildGroup: (groupId: string, id: string): Part => TestModel.toolCall("await_child_group", { groupId }, { id }),
  failure: (description: string, delayMillis?: number): Step =>
    TestModel.failure(
      AiError.make({
        module: "rika/baton-test-harness",
        method: "streamText",
        reason: AiError.UnknownError.make({ description }),
      }),
      delayMillis === undefined ? {} : { delay: `${delayMillis} millis` },
    ),
}

const identityFor = (profile: Profile) => `test-lane-${profile.toLowerCase()}`

const withLaneIdentity = (
  snapshot: ExecutionRouteSnapshot.ExecutionRouteModelSnapshot,
  profile: Profile,
): ExecutionRouteSnapshot.ExecutionRouteModelSnapshot => {
  const identity = identityFor(profile)
  return {
    ...snapshot,
    registrationIdentity: identity as typeof snapshot.registrationIdentity,
    candidates: snapshot.candidates.map((candidate) => ({
      ...candidate,
      registrationIdentity: identity as typeof candidate.registrationIdentity,
    })),
  }
}

export const laneExecutionRoute = (mode = "test"): ExecutionRouteSnapshot.ExecutionRouteSnapshot => {
  const route = testExecutionRoute(mode)
  return {
    ...route,
    title: withLaneIdentity(route.title, "Title"),
    compactionSummary: withLaneIdentity(route.compactionSummary, "Compaction"),
    main: withLaneIdentity(route.main, "Root"),
    oracle: withLaneIdentity(route.oracle, "Oracle"),
    agents: {
      librarian: withLaneIdentity(route.agents.librarian, "Librarian"),
      painter: withLaneIdentity(route.agents.painter, "Painter"),
      readThread: withLaneIdentity(route.agents.readThread, "ReadThread"),
      review: withLaneIdentity(route.agents.review, "Review"),
      surgeon: withLaneIdentity(route.agents.surgeon, "Surgeon"),
      task: withLaneIdentity(route.agents.task, "Task"),
    },
  }
}

const idleSteps = Array.from({ length: 16 }, () => TestModel.turn([TestModel.text("idle")]))

export interface LaneModels {
  readonly registryLayer: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly requestCount: Effect.Effect<number>
  readonly requestCountFor: (profile: Profile) => Effect.Effect<number>
}

const groupPattern = /"groupId":"(fanout_[a-z0-9]+)"/u

const admittedGroup = (prompt: LanguageModel.ProviderOptions["prompt"]): string | undefined => {
  const matches = [...JSON.stringify(prompt.content).matchAll(new RegExp(groupPattern, "gu"))]
  return matches.at(-1)?.[1]
}

const withAdmittedGroup =
  (prompt: LanguageModel.ProviderOptions["prompt"]) =>
  <A>(part: A): A => {
    const candidate = part as { readonly type?: string; readonly name?: string }
    if (candidate.type !== "tool-call" || candidate.name !== ChildRuns.awaitGroupToolName) return part
    const groupId = admittedGroup(prompt)
    return groupId === undefined ? part : ({ ...candidate, params: { groupId } } as A)
  }

const resolvingGroupReceipts = (service: LanguageModel.Service): LanguageModel.Service =>
  ({
    ...service,
    generateText: (options: LanguageModel.ProviderOptions) =>
      service.generateText(options as never).pipe(
        Effect.map((response: { readonly content: ReadonlyArray<unknown> }) => ({
          ...response,
          content: response.content.map(withAdmittedGroup(options.prompt)),
        })),
      ) as never,
    streamText: (options: LanguageModel.ProviderOptions) =>
      service.streamText(options as never).pipe(Stream.map(withAdmittedGroup(options.prompt))) as never,
  }) as LanguageModel.Service

export const makeLaneModels = Effect.fn("BatonTestHarness.makeLaneModels")(function* (
  lanes: ReadonlyArray<Lane>,
): Effect.gen.Return<LaneModels, never, Scope.Scope> {
  const declared = new Map(lanes.map((lane) => [lane.profile ?? "Root", lane.steps] as const))
  const fixtures = yield* Effect.forEach(profiles, (profile) =>
    TestModel.make(declared.get(profile) ?? idleSteps, {
      provider: "test",
      model: "test",
      registrationKey: identityFor(profile),
    }),
  )
  const registrations = yield* Effect.forEach(fixtures, (fixture, index) =>
    Layer.build(fixture.layer).pipe(
      Effect.flatMap((context) =>
        ModelRegistry.registration({
          provider: "test",
          model: "test",
          registrationKey: identityFor(profiles[index]!),
          layer: Layer.succeed(
            LanguageModel.LanguageModel,
            resolvingGroupReceipts(Context.get(context, LanguageModel.LanguageModel)),
          ),
        }),
      ),
    ),
  )
  return {
    registryLayer: ModelRegistry.layer(
      registrations.map((registration) => Effect.succeed({ ...registration, isAvailabilityFailure: () => false })),
    ),
    requestCount: Effect.forEach(fixtures, (fixture) => fixture.requests).pipe(
      Effect.map((batches) => batches.reduce((total, requests) => total + requests.length, 0)),
    ),
    requestCountFor: (profile) =>
      fixtures[profiles.indexOf(profile)]!.requests.pipe(Effect.map((requests) => requests.length)),
  } satisfies LaneModels
})
