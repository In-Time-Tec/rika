import { BlobStore, type Content } from "@relayfx/sdk"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as DataBlobStore from "../src/data-blob-store"

const blob = (uri: string, mediaType = "image/png", filename?: string): Content.BlobReferencePart => ({
  type: "blob-reference",
  uri,
  media_type: mediaType,
  ...(filename === undefined ? {} : { filename }),
})

describe("data blob store", () => {
  it.layer(DataBlobStore.layer)((test) => {
    test.effect("validates canonical image data while keeping a durable string reference", () =>
      Effect.gen(function* () {
        const resolved = yield* BlobStore.resolve(blob("data:image/png;base64,AQ==", "image/png", "shot.png"))
        assert.deepStrictEqual(resolved, {
          _tag: "Url",
          url: "data:image/png;base64,AQ==",
          mediaType: "image/png",
          fileName: "shot.png",
        })
        assert.deepStrictEqual(DataBlobStore.decode("data:image/png;base64,AQ==", "image/png"), Uint8Array.from([1]))
      }),
    )

    test.effect("rejects malformed, mismatched, empty, and oversized inline data", () =>
      Effect.gen(function* () {
        const malformed = [
          blob("data:image/png;base64,%!%%"),
          blob("data:image/png;base64,AQ"),
          blob("data:image/png;base64,AQ==\n"),
          blob("data:image/png;base64,AR=="),
          blob("data:image/png;base64,"),
          blob("data:image/jpeg;base64,AQ=="),
          blob("data:image/png;charset=utf-8;base64,AQ=="),
          blob("data:image/png,%41"),
          blob("data:text/plain;base64,AQ==", "text/plain"),
          blob("data:application/pdf;base64,AQ==", "application/pdf"),
          blob("data:image/png;base64,AQ==", "image/png;base64,text/plain"),
          blob(`data:image/png;base64,${"A".repeat(6_666_669)}`),
        ]
        const failures = yield* Effect.forEach(malformed, (part) => Effect.flip(BlobStore.resolve(part)))
        assert.deepStrictEqual(
          failures.map((failure) => failure._tag),
          malformed.map(() => "BlobNotResolvable"),
        )
      }),
    )

    test.effect("preserves non-data references as URLs", () =>
      Effect.gen(function* () {
        const references = [
          blob("https://example.com/shot.png", "image/png", "shot.png"),
          blob("file:///workspace/shot.png"),
          blob("memory://blob/1", "application/octet-stream"),
        ]
        const resolved = yield* Effect.forEach(references, BlobStore.resolve)
        assert.deepStrictEqual(resolved, [
          {
            _tag: "Url",
            url: "https://example.com/shot.png",
            mediaType: "image/png",
            fileName: "shot.png",
          },
          { _tag: "Url", url: "file:///workspace/shot.png", mediaType: "image/png" },
          { _tag: "Url", url: "memory://blob/1", mediaType: "application/octet-stream" },
        ])
      }),
    )

    test.effect("rejects writes instead of embedding oversized tool output", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          BlobStore.put({ bytes: Uint8Array.from([1, 2, 3]), mediaType: "application/octet-stream" }),
        )
        assert.strictEqual(failure._tag, "BlobStoreError")
        assert.match(failure.message, /does not support writes/)
      }),
    )
  })
})
