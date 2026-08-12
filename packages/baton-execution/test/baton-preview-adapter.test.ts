import * as ExecutionProjection from "@rika/product/execution-projection"
import type * as Runtime from "@batonfx/runtime"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Ref, Stream } from "effect"
import { merge, modelPreviewEvent } from "../src/baton-preview-adapter"

const runtimePreview = (overrides: Partial<Runtime.ModelPreview.Frame> = {}): Runtime.ModelPreview.Frame => ({
  _tag: "ModelPreview" as const,
  runId: "run-1",
  attemptFence: 7,
  turn: 2,
  modelCallId: "call-1",
  modelAttemptId: "attempt-1",
  attempt: 3,
  sequence: 0,
  changes: [{ channel: "text" as const, offset: 0, delta: "hel" }] as const,
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

it("passes released append frames through without adding durable projection coordinates", () => {
  const runtime = runtimePreview()
  const preview = modelPreviewEvent(runtime)
  expect(preview).toBe(runtime)
  expect(Object.hasOwn(preview, "cursor")).toBe(false)
  expect(Object.hasOwn(preview, "checkpoint")).toBe(false)
  expect(Object.hasOwn(preview, "projectionRevision")).toBe(false)
})

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
