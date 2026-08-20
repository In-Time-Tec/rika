import { AiError, ModelRegistry, Response as AiResponse } from "tenetkit"
import { CellTool } from "tenetkit/repl"
import { TestModel } from "tenetkit/test"
import type * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer, Ref, Scope, Stream } from "effect"
import { LanguageModel, type Prompt } from "effect/unstable/ai"

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

export interface ProviderHttpEnvelope {
  readonly request: NonNullable<AiResponse.ResponseMetadataPart["request"]>
  readonly response: NonNullable<AiResponse.FinishPart["response"]>
}

export interface Lane {
  readonly profile?: Profile
  readonly steps: ReadonlyArray<Step>
  readonly providerHttpEnvelope?: ProviderHttpEnvelope
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

/** One `rika.<module>.<operation>(input)` call a scripted cell makes. */
interface BindingCall {
  readonly module: string
  readonly operation: string
  readonly input?: unknown
}

interface SpawnRequest {
  readonly profile: Profile
  readonly prompt: string
  readonly name?: string
}

/**
 * A cell that awaits one binding and returns its value. The model can only act through the cell, so
 * a scripted tool call is scripted cell source, and the source is what the transcript projects.
 */
const callSource = (call: BindingCall): string =>
  `rika.${call.module}.${call.operation}(${JSON.stringify(call.input ?? {})})`

const bindingSource = (call: BindingCall): string => `await ${callSource(call)}`

export const step = {
  text: (value: string, delayMillis?: number): Step =>
    TestModel.turn([TestModel.text(value)], delayMillis === undefined ? {} : { delay: `${delayMillis} millis` }),
  turn: (
    parts: ReadonlyArray<Part>,
    options: {
      readonly delayMillis?: number
      readonly streamPartDelayMillis?: number
      readonly inputTokens?: number
      readonly outputTokens?: number
    } = {},
  ): Step =>
    TestModel.turn(parts, {
      ...(options.delayMillis === undefined ? {} : { delay: `${options.delayMillis} millis` }),
      ...(options.streamPartDelayMillis === undefined
        ? {}
        : { streamPartDelay: `${options.streamPartDelayMillis} millis` }),
      ...(options.inputTokens === undefined && options.outputTokens === undefined ? {} : { usage: usage(options) }),
    }),
  part: (value: string): Part => TestModel.text(value),
  reasoning: (value: string): Part => TestModel.reasoning(value),
  cell: (code: string, id: string): Part => TestModel.toolCall(CellTool.name, { code }, { id }),
  binding: (call: BindingCall, id: string): Part => step.cell(bindingSource(call), id),
  bindings: (calls: ReadonlyArray<BindingCall>, id: string): Part => step.cell(calls.map(bindingSource).join("\n"), id),
  spawn: (children: ReadonlyArray<SpawnRequest>, id: string): Part =>
    children.length === 1
      ? TestModel.toolCall(
          "run_child",
          {
            selection: children[0]!.profile,
            prompt: children[0]!.prompt,
            ...(children[0]!.name === undefined ? {} : { label: children[0]!.name }),
          },
          { id },
        )
      : TestModel.toolCall(
          "run_child_group",
          {
            members: children.map((child, index) => ({
              key: child.name ?? `${child.profile.toLowerCase()}-${index}`,
              selection: child.profile,
              prompt: child.prompt,
              ...(child.name === undefined ? {} : { label: child.name }),
            })),
            concurrency: children.length,
          },
          { id },
        ),
  failure: (description: string, delayMillis?: number): Step =>
    TestModel.failure(
      AiError.make({
        module: "rika/execution/test-harness",
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

export interface ProviderHttpEnvelopeCounts {
  readonly request: number
  readonly response: number
}

export interface LaneModels {
  readonly registryLayer: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly requestCount: Effect.Effect<number>
  readonly requestCountFor: (profile: Profile) => Effect.Effect<number>
  readonly requestsFor: (profile: Profile) => Effect.Effect<ReadonlyArray<TestModel.Request>>
  readonly promptsFor: (profile: Profile) => Effect.Effect<ReadonlyArray<Prompt.Prompt>>
  readonly providerHttpEnvelopeCountsFor: (profile: Profile) => Effect.Effect<ProviderHttpEnvelopeCounts>
}

const withProviderHttpEnvelope = (
  service: LanguageModel.Service,
  envelope: ProviderHttpEnvelope,
  observed: Ref.Ref<ProviderHttpEnvelopeCounts>,
): LanguageModel.Service => ({
  ...service,
  streamText: ((options: Parameters<LanguageModel.Service["streamText"]>[0]) => {
    const metadata = AiResponse.makePart("response-metadata", {
      id: "provider-response-0",
      modelId: "provider-model",
      timestamp: undefined,
      request: envelope.request,
    })
    return Stream.concat(
      Stream.succeed(metadata),
      service
        .streamText(options)
        .pipe(Stream.map((part) => (part.type === "finish" ? { ...part, response: envelope.response } : part))),
    ).pipe(
      Stream.tap((part) => {
        if (part.type === "response-metadata" && part.request === envelope.request) {
          return Ref.update(observed, (counts) => ({ ...counts, request: counts.request + 1 }))
        }
        if (part.type === "finish" && part.response === envelope.response) {
          return Ref.update(observed, (counts) => ({ ...counts, response: counts.response + 1 }))
        }
        return Effect.void
      }),
    )
  }) as LanguageModel.Service["streamText"],
})

export const makeLaneModels = Effect.fn("TestHarness.makeLaneModels")(function* (
  lanes: ReadonlyArray<Lane>,
): Effect.gen.Return<LaneModels, never, Scope.Scope> {
  const declared = new Map(lanes.map((lane) => [lane.profile ?? "Root", lane] as const))
  const fixtures = yield* Effect.forEach(profiles, (profile) =>
    TestModel.make(declared.get(profile)?.steps ?? idleSteps, {
      provider: "test",
      model: "test",
      registrationKey: identityFor(profile),
    }),
  )
  const envelopeCounts = yield* Effect.forEach(profiles, () => Ref.make({ request: 0, response: 0 }))
  const registrations = yield* Effect.forEach(fixtures, (fixture, index) =>
    Layer.build(fixture.layer).pipe(
      Effect.flatMap((context) => {
        const profile = profiles[index]!
        const service = Context.get(context, LanguageModel.LanguageModel)
        const envelope = declared.get(profile)?.providerHttpEnvelope
        return ModelRegistry.registration({
          provider: "test",
          model: "test",
          registrationKey: identityFor(profile),
          layer: Layer.succeed(
            LanguageModel.LanguageModel,
            envelope === undefined ? service : withProviderHttpEnvelope(service, envelope, envelopeCounts[index]!),
          ),
        })
      }),
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
    requestsFor: (profile) => fixtures[profiles.indexOf(profile)]!.requests,
    promptsFor: (profile) => fixtures[profiles.indexOf(profile)]!.prompts,
    providerHttpEnvelopeCountsFor: (profile) => Ref.get(envelopeCounts[profiles.indexOf(profile)]!),
  } satisfies LaneModels
})
