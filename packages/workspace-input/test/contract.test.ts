import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { EncodedArchive, MaximumArchiveBytes, MaximumEncryptedArchiveBytes, StoredArchive } from "../src/contract"

const digest = `sha256:${"a".repeat(64)}`

describe("Workspace input contracts", () => {
  it("bounds encoded and encrypted archive descriptors", () => {
    expect(Schema.is(EncodedArchive)({ content: "YQ==", contentDigest: digest, sizeBytes: 1 })).toBe(true)
    expect(
      Schema.is(EncodedArchive)({ content: "YQ==", contentDigest: digest, sizeBytes: MaximumArchiveBytes + 1 }),
    ).toBe(false)
    const stored = {
      objectKey: "workspace-input/v1/workspace-seeds/key/source.archive.aes",
      contentDigest: digest,
      sizeBytes: 64,
      archiveDigest: digest,
      archiveSizeBytes: 32,
      encryption: "aes-256-gcm",
    }
    expect(Schema.is(StoredArchive)(stored)).toBe(true)
    expect(Schema.is(StoredArchive)({ ...stored, sizeBytes: MaximumEncryptedArchiveBytes + 1 })).toBe(false)
    expect(Schema.is(StoredArchive)({ ...stored, archiveSizeBytes: MaximumArchiveBytes + 1 })).toBe(false)
    expect(Schema.is(StoredArchive)({ ...stored, encryption: "none" })).toBe(false)
  })
})
