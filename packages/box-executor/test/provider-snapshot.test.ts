import { Effect, Redacted, Schema } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { BoxId } from "../src/contract"
import { makeBoxHttpProvider } from "../src/provider"

const boxId = Schema.decodeSync(BoxId)("bx_abcdefgh")
const reference = {
  id: "9115dc41-0f79-4525-8c75-12ef2391bda7",
  boxId,
  generation: null,
  completedAt: "2026-09-10T21:16:40.421Z",
  sizeBytes: null,
  fileCount: null,
}
const provider = (snapshot: Schema.Json) =>
  makeBoxHttpProvider({
    baseUrl: "https://box.invalid",
    apiKey: Redacted.make(""),
    transport: {
      request: () => Effect.succeed(Response.json({ ok: true, type: "snapshot.latest", snapshot })),
    },
  })

it.effect("retains unknown statistics on a completed inherited Box snapshot without inventing zeroes", () =>
  Effect.gen(function* () {
    expect(yield* provider({ ...reference, status: "completed", kind: "reference" }).latestSnapshot(boxId)).toEqual(
      reference,
    )
  }),
)

it.effect("does not use an incomplete snapshot even when its reference and statistics are valid", () =>
  Effect.gen(function* () {
    const snapshot = { ...reference, status: "running", generation: 1, sizeBytes: 4096, fileCount: 3 }
    expect(yield* Effect.result(provider(snapshot).latestSnapshot(boxId))).toMatchObject({
      _tag: "Failure",
      failure: { operation: "latest-snapshot", kind: "invalid-response" },
    })
  }),
)

it.effect("retains the absence of a completed snapshot", () =>
  Effect.gen(function* () {
    expect(yield* provider(null).latestSnapshot(boxId)).toBeNull()
  }),
)
