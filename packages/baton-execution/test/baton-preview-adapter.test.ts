import * as ExecutionProjection from "@rika/product/execution-projection"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Ref, Stream } from "effect"
import { accumulate, merge, modelPreviewed, previewIdentity, replacePreview } from "../src/baton-preview-adapter"

const runtimePreview = (overrides: Partial<Parameters<typeof modelPreviewed>[0]> = {}) => ({
  runId: "run-1",
  attemptFence: 7,
  turn: 2,
  modelCallId: "call-1",
  modelAttemptId: "attempt-1",
  attempt: 3,
  revision: 1,
  text: "hel",
  reasoning: "why",
  truncated: false,
  ...overrides,
})

const completed: ExecutionProjection.Change = {
  _tag: "ProjectionSnapshot",
  revision: 1,
  units: [],
  hasOlder: false,
  state: {
    status: "completed",
    usage: ExecutionProjection.emptyUsageState(),
    steering: { steeringMessages: 0, followUpMessages: 0 },
  },
}

it("maps every runtime identity field without adding durable projection coordinates", () => {
  const preview = modelPreviewed(runtimePreview())
  expect(preview).toEqual({
    _tag: "ModelPreviewed",
    key: {
      runId: "run-1",
      attemptFence: 7,
      turn: 2,
      modelCallId: "call-1",
      modelAttemptId: "attempt-1",
      attempt: 3,
    },
    revision: 1,
    text: "hel",
    reasoning: "why",
    truncated: false,
  })
  expect(Object.hasOwn(preview, "cursor")).toBe(false)
  expect(Object.hasOwn(preview, "checkpoint")).toBe(false)
  expect(Object.hasOwn(preview, "projectionRevision")).toBe(false)

  const bounded = modelPreviewed(runtimePreview({ text: "x".repeat(5_000), reasoning: "y".repeat(5_000) }))
  expect(bounded.text.length + bounded.reasoning.length).toBe(4_096)
  expect(bounded.truncated).toBe(true)
})

it("replaces cumulative text by identity while retaining distinct old attempts", () => {
  const hel = modelPreviewed(runtimePreview())
  const hello = modelPreviewed(runtimePreview({ revision: 2, text: "hello" }))
  const stale = modelPreviewed(runtimePreview({ revision: 1, text: "h" }))
  const retried = modelPreviewed(
    runtimePreview({ attemptFence: 8, modelAttemptId: "attempt-2", attempt: 4, revision: 1, text: "again" }),
  )
  const first = replacePreview({ current: new Map(), preview: hel })
  const replaced = replacePreview({ current: first, preview: hello })
  const unchanged = replacePreview({ current: replaced, preview: stale })
  const retained = replacePreview({ current: unchanged, preview: retried })

  expect(replaced.size).toBe(1)
  expect(replaced.get(previewIdentity(hel))?.text).toBe("hello")
  expect(unchanged).toBe(replaced)
  expect(retained.size).toBe(2)
  expect(previewIdentity(retried)).not.toBe(previewIdentity(hello))
})

it.effect("accumulates ordered Baton frames and clears the matching attempt", () =>
  Effect.gen(function* () {
    const events = Stream.fromIterable([
      {
        _tag: "ModelPreview" as const,
        runId: "run-1",
        attemptFence: 7,
        turn: 2,
        modelCallId: "call-1",
        modelAttemptId: "attempt-1",
        attempt: 3,
        sequence: 0,
        changes: [{ channel: "reasoning" as const, offset: 0, delta: "why" }] as const,
      },
      {
        _tag: "ModelPreview" as const,
        runId: "run-1",
        attemptFence: 7,
        turn: 2,
        modelCallId: "call-1",
        modelAttemptId: "attempt-1",
        attempt: 3,
        sequence: 1,
        changes: [{ channel: "text" as const, offset: 0, delta: "hello" }] as const,
      },
      { _tag: "ModelPreviewCleared" as const, runId: "run-1", attemptFence: 7, generation: 2 },
    ])
    const values = Array.from(yield* accumulate(events).pipe(Stream.runCollect))
    expect(values.map(({ revision, text, reasoning }) => ({ revision, text, reasoning }))).toEqual([
      { revision: 0, text: "", reasoning: "why" },
      { revision: 1, text: "hello", reasoning: "why" },
      { revision: 2, text: "", reasoning: "" },
    ])
  }),
)

it.effect("keeps retained and dropped preview frames truncated until their attempt clears", () =>
  Effect.gen(function* () {
    const frame = (
      sequence: number,
      changes: ReadonlyArray<{
        readonly channel: "text" | "reasoning"
        readonly offset: number
        readonly delta: string
      }>,
    ) => ({
      _tag: "ModelPreview" as const,
      runId: "run-1",
      attemptFence: 7,
      turn: 2,
      modelCallId: "call-1",
      modelAttemptId: "attempt-1",
      attempt: 3,
      sequence,
      changes: changes as never,
    })
    const retained = Array.from(
      yield* accumulate(Stream.fromIterable([frame(7, [{ channel: "text", offset: 200, delta: "tail" }])])).pipe(
        Stream.runCollect,
      ),
    )
    expect(retained).toEqual([expect.objectContaining({ revision: 7, text: "…tail", truncated: true })])

    const dropped = Array.from(
      yield* accumulate(
        Stream.fromIterable([
          frame(0, [{ channel: "reasoning", offset: 0, delta: "a" }]),
          frame(2, [{ channel: "text", offset: 0, delta: "b" }]),
          frame(3, [{ channel: "text", offset: 1, delta: "c" }]),
          { _tag: "ModelPreviewCleared" as const, runId: "run-1", attemptFence: 7, generation: 2 },
          frame(0, [{ channel: "text", offset: 0, delta: "fresh" }]),
        ]),
      ).pipe(Stream.runCollect),
    )
    expect(dropped.map(({ revision, truncated }) => ({ revision, truncated }))).toEqual([
      { revision: 0, truncated: false },
      { revision: 2, truncated: true },
      { revision: 3, truncated: true },
      { revision: 4, truncated: false },
      { revision: 0, truncated: false },
    ])
  }),
)

it.effect("ends and interrupts previews when the durable projection watch ends", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>()
    const finalized = yield* Ref.make(false)
    const previews = Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
      Stream.drain,
      Stream.concat(Stream.never),
      Stream.ensuring(Ref.set(finalized, true)),
    )
    const projections = Stream.fromEffect(Deferred.await(subscribed)).pipe(Stream.map(() => completed))
    const values = yield* merge({ projections, previews }).pipe(Stream.runCollect)
    expect(Array.from(values)).toEqual([completed])
    expect(yield* Ref.get(finalized)).toBe(true)
  }),
)
