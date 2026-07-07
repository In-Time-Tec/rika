import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { ArtifactStore, Database, Migration, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids } from "@rika/schema"
import { Effect, Layer, Schema, Stream } from "effect"
import { JudgeService } from "../src/index"

const now = Common.TimestampMillis.make(2_100_000_000_000)
const threadId = Ids.ThreadId.make("thread_judge_service")
const workspaceId = Ids.WorkspaceId.make("workspace_judge_service")
const candidates = [
  { id: "a", label: "Alpha", content: "alpha answer" },
  { id: "b", label: "Beta", content: "beta answer" },
  { id: "c", label: "Gamma", content: "gamma answer" },
]

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace",
  data_dir: "/workspace/.rika",
  default_mode: "smart",
})

const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(SecretRedactor.layer))

const judgeDraft = (
  winnerId: string,
  scores: ReadonlyArray<{
    readonly candidate_id: string
    readonly score: number
    readonly strengths: string
    readonly weaknesses: string
  }>,
  rationale: string,
) => ({ scores, winner_id: winnerId, rationale })

const makeRouterLayer = (drafts: ReadonlyArray<ReturnType<typeof judgeDraft>>) => {
  let index = 0
  const requests: Array<Router.StructuredRequest<Record<string, unknown>>> = []
  const layer = Layer.succeed(
    Router.Service,
    Router.Service.of({
      route: (request) =>
        Effect.succeed({
          mode: request.mode ?? "smart",
          profile: request.profile,
          provider: request.provider ?? "openai",
          model: request.model ?? "gpt-5.5",
          messages: request.messages,
          reasoning_effort: request.reasoning_effort ?? "xhigh",
        }),
      complete: () => Effect.die(new Error("plain completion not configured")),
      completeStructured: <A extends Record<string, any>>(request: Router.StructuredRequest<A>) =>
        Effect.sync(() => {
          requests.push(request)
          const draft =
            drafts[index] ??
            judgeDraft("a", [{ candidate_id: "a", score: 1, strengths: "fallback", weaknesses: "none" }], "fallback")
          index += 1
          return {
            value: Schema.decodeUnknownSync(request.schema)(draft),
            raw: {
              provider: "openai",
              model: "gpt-5.5",
              content: JSON.stringify(draft),
            },
          }
        }),
      stream: () => Stream.empty,
    }),
  )
  return { layer, requests }
}

const makeLayer = (routerLayer: Layer.Layer<Router.Service>) =>
  JudgeService.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    Layer.provideMerge(Time.fixedLayer(now)),
    Layer.provideMerge(ArtifactStore.fakeLayer()),
    Layer.provideMerge(routerLayer),
  )

const makeLiveishLayer = (responses: ReadonlyArray<string>) => {
  const databaseLayer = Database.memoryLayer
  return JudgeService.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    Layer.provideMerge(Time.fixedLayer(now)),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(Migration.layer),
    Layer.provideMerge(ThreadProjection.layer),
    Layer.provideMerge(ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))),
    Layer.provideMerge(
      Router.layer.pipe(
        Layer.provideMerge(configLayer),
        Layer.provideMerge(Provider.fakeRegistryLayer([{ name: "openai", responses }])),
        Layer.provideMerge(diagnosticsLayer),
      ),
    ),
  )
}

describe("JudgeService", () => {
  test("rotates candidates across judges, aggregates the verdict, and persists a verdict artifact", async () => {
    const drafts = [
      judgeDraft(
        "b",
        [
          { candidate_id: "a", score: 8, strengths: "a stable", weaknesses: "a narrow" },
          { candidate_id: "b", score: 9, strengths: "b best 1", weaknesses: "b small" },
          { candidate_id: "c", score: 4, strengths: "c partial", weaknesses: "c misses task" },
        ],
        "b wins judge 1",
      ),
      judgeDraft(
        "a",
        [
          { candidate_id: "b", score: 7, strengths: "b okay", weaknesses: "b broad" },
          { candidate_id: "c", score: 6, strengths: "c okay", weaknesses: "c risky" },
          { candidate_id: "a", score: 9, strengths: "a best", weaknesses: "a small" },
        ],
        "a wins judge 2",
      ),
      judgeDraft(
        "b",
        [
          { candidate_id: "c", score: 5, strengths: "c modest", weaknesses: "c incomplete" },
          { candidate_id: "a", score: 8, strengths: "a solid", weaknesses: "a limited" },
          { candidate_id: "b", score: 8, strengths: "b best 3", weaknesses: "b tradeoff" },
        ],
        "b wins judge 3",
      ),
    ]
    const router = makeRouterLayer(drafts)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const verdict = yield* JudgeService.compare({
          task: "Pick the safest implementation.",
          content_kind: "answer",
          candidates,
          judges: 3,
          thread_id: threadId,
        })
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "verdict" })
        return { verdict, artifacts }
      }).pipe(Effect.provide(makeLayer(router.layer))),
    )

    expect(router.requests).toHaveLength(3)
    expect(router.requests.map((request) => request.profile)).toEqual(["oracle", "oracle", "oracle"])
    expect(candidateOrderText(router.requests[0])).toEqual(["a", "b", "c"])
    expect(candidateOrderText(router.requests[1])).toEqual(["b", "c", "a"])
    expect(candidateOrderText(router.requests[2])).toEqual(["c", "a", "b"])
    expect(result.verdict.winner_id).toBe("b")
    expect(result.verdict.ranking).toEqual([
      { candidate_id: "b", median_score: 8, first_place_votes: 2 },
      { candidate_id: "a", median_score: 8, first_place_votes: 1 },
      { candidate_id: "c", median_score: 5, first_place_votes: 0 },
    ])
    expect(result.verdict.rationale).toBe("b best 1\nb best 3")
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toMatchObject({
      id: "artifact_1",
      thread_id: threadId,
      kind: "verdict",
      title: "Judge verdict",
      created_at: now,
      metadata: { winner_id: "b", candidate_count: 3, judge_count: 3 },
      content: result.verdict,
    })
  })

  test("rejects fewer than two or more than eight candidates with a typed error", async () => {
    const router = makeRouterLayer([])
    const layer = makeLayer(router.layer)

    const oneCandidate = await Effect.runPromise(
      JudgeService.compare({
        task: "Pick one.",
        content_kind: "answer",
        candidates: [candidates[0]!],
        thread_id: threadId,
      }).pipe(Effect.provide(layer), Effect.flip),
    )
    const nineCandidates = await Effect.runPromise(
      JudgeService.compare({
        task: "Pick one.",
        content_kind: "answer",
        candidates: Array.from({ length: 9 }, (_, index) => ({
          id: `candidate_${index}`,
          label: `Candidate ${index}`,
          content: `content ${index}`,
        })),
        thread_id: threadId,
      }).pipe(Effect.provide(layer), Effect.flip),
    )

    expect(oneCandidate).toBeInstanceOf(JudgeService.JudgeError)
    expect(oneCandidate).toMatchObject({ _tag: "JudgeError", operation: "validate" })
    expect(nineCandidates).toBeInstanceOf(JudgeService.JudgeError)
    expect(nineCandidates).toMatchObject({ _tag: "JudgeError", operation: "validate" })
    expect(router.requests).toEqual([])
  })

  test("uses original candidate order when median scores and first-place votes tie", async () => {
    const router = makeRouterLayer([
      judgeDraft(
        "b",
        [
          { candidate_id: "a", score: 8, strengths: "a", weaknesses: "none" },
          { candidate_id: "b", score: 8, strengths: "b", weaknesses: "none" },
        ],
        "b wins judge 1",
      ),
      judgeDraft(
        "a",
        [
          { candidate_id: "b", score: 8, strengths: "b", weaknesses: "none" },
          { candidate_id: "a", score: 8, strengths: "a", weaknesses: "none" },
        ],
        "a wins judge 2",
      ),
    ])

    const verdict = await Effect.runPromise(
      JudgeService.compare({
        task: "Break the tie.",
        content_kind: "answer",
        candidates: candidates.slice(0, 2),
        judges: 2,
        thread_id: threadId,
      }).pipe(Effect.provide(makeLayer(router.layer))),
    )

    expect(verdict.winner_id).toBe("a")
    expect(verdict.ranking).toEqual([
      { candidate_id: "a", median_score: 8, first_place_votes: 1 },
      { candidate_id: "b", median_score: 8, first_place_votes: 1 },
    ])
  })

  test("rejects judge output that references unknown candidates", async () => {
    const unknownRouter = makeRouterLayer([
      judgeDraft(
        "missing",
        [
          { candidate_id: "a", score: 8, strengths: "a", weaknesses: "none" },
          { candidate_id: "b", score: 7, strengths: "b", weaknesses: "none" },
        ],
        "unknown winner",
      ),
    ])

    const error = await Effect.runPromise(
      JudgeService.compare({
        task: "Reject invalid ids.",
        content_kind: "answer",
        candidates: candidates.slice(0, 2),
        judges: 1,
        thread_id: threadId,
      }).pipe(Effect.provide(makeLayer(unknownRouter.layer)), Effect.flip),
    )
    const duplicateRouter = makeRouterLayer([
      judgeDraft(
        "a",
        [
          { candidate_id: "a", score: 8, strengths: "a", weaknesses: "none" },
          { candidate_id: "b", score: 7, strengths: "b", weaknesses: "none" },
          { candidate_id: "b", score: 6, strengths: "duplicate", weaknesses: "extra" },
        ],
        "duplicate score",
      ),
    ])
    const duplicateError = await Effect.runPromise(
      JudgeService.compare({
        task: "Reject duplicate rows.",
        content_kind: "answer",
        candidates: candidates.slice(0, 2),
        judges: 1,
        thread_id: threadId,
      }).pipe(Effect.provide(makeLayer(duplicateRouter.layer)), Effect.flip),
    )

    expect(error).toBeInstanceOf(JudgeService.JudgeError)
    expect(error).toMatchObject({ _tag: "JudgeError", operation: "judgeOutput" })
    expect(duplicateError).toBeInstanceOf(JudgeService.JudgeError)
    expect(duplicateError).toMatchObject({ _tag: "JudgeError", operation: "judgeOutput" })
  })

  test("runs through Router.completeStructured with the fake provider layer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadProjection.apply(threadCreated(threadId, workspaceId))
        const verdict = yield* JudgeService.compare({
          task: "Pick the safest diff.",
          content_kind: "diff",
          rubric: "Prefer tested, minimal changes.",
          candidates: candidates.slice(0, 2),
          judges: 1,
          thread_id: threadId,
        })
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "verdict" })
        const workspaceArtifacts = yield* ArtifactStore.listAll({ workspace_id: workspaceId, kind: "verdict" })
        return { verdict, artifacts, workspaceArtifacts }
      }).pipe(
        Effect.provide(
          makeLiveishLayer([
            JSON.stringify(
              judgeDraft(
                "a",
                [
                  { candidate_id: "a", score: 10, strengths: "tested and scoped", weaknesses: "none" },
                  { candidate_id: "b", score: 5, strengths: "partial", weaknesses: "missing tests" },
                ],
                "a wins",
              ),
            ),
          ]),
        ),
      ),
    )

    expect(result.verdict).toMatchObject({
      winner_id: "a",
      ranking: [
        { candidate_id: "a", median_score: 10, first_place_votes: 1 },
        { candidate_id: "b", median_score: 5, first_place_votes: 0 },
      ],
      rationale: "tested and scoped",
    })
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]?.content).toEqual(result.verdict)
    expect(result.workspaceArtifacts).toEqual(result.artifacts)
  })
})

const candidateOrderText = (request: Router.StructuredRequest<Record<string, unknown>> | undefined) => {
  const text = JSON.stringify(request?.messages ?? [])
  return ["a", "b", "c"]
    .map((id) => ({ id, index: text.indexOf(`Candidate ${id}`) }))
    .toSorted((left, right) => left.index - right.index)
    .map((entry) => entry.id)
}

const threadCreated = (eventThreadId: Ids.ThreadId, eventWorkspaceId: Ids.WorkspaceId): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_${eventThreadId}_created`),
  thread_id: eventThreadId,
  sequence: 1,
  version: 1,
  type: "thread.created",
  created_at: now,
  data: { workspace_id: eventWorkspaceId },
})
