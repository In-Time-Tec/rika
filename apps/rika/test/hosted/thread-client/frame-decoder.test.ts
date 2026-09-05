import { expect, it } from "@effect/vitest"
import { protocolVersion } from "@rika/product/client-protocol"
import { Effect, Schema } from "effect"
import { decodeThreadFrame, safeFrameIssues } from "../../../src/hosted/thread-client/frame-decoder"

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

it.effect("decodes valid frames and explains incompatible versions", () =>
  Effect.gen(function* () {
    const frame = { protocolVersion, payload: { _tag: "Heartbeat", at: "2026-09-05T00:00:00.000Z" } }
    expect(yield* decodeThreadFrame(encode(frame))).toEqual(frame)
    const error = yield* Effect.flip(decodeThreadFrame(encode({ ...frame, protocolVersion: protocolVersion - 1 })))
    expect(error.kind).toBe("protocol")
    expect(error.message).toContain("update rika")
    const future = yield* Effect.flip(
      decodeThreadFrame(encode({ protocolVersion: protocolVersion + 1, payload: { _tag: "FutureFrame" } })),
    )
    expect(future.message).toContain("update rika")
  }),
)

it.effect("rejects malformed JSON without retaining its contents in the user-facing error", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(decodeThreadFrame("secret-invalid-json"))
    expect(error.message).toContain("diagnostic details recorded")
    expect(error.message).not.toContain("secret")
  }),
)

it.effect("reports only safe schema paths and issue kinds, not dynamic keys or input values", () =>
  Effect.gen(function* () {
    const schema = Schema.Struct({ payload: Schema.Record(Schema.String, Schema.Struct({ revision: Schema.Int })) })
    const error = yield* Effect.flip(
      Schema.decodeUnknownEffect(schema)({ payload: { "secret-key": { revision: "secret-value" } } }),
    )
    const issues = safeFrameIssues(error.issue).join(";")
    expect(issues).toContain("payload.<key>.revision")
    expect(issues).not.toContain("secret")
  }),
)
