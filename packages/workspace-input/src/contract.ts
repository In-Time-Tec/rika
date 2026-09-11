import { Schema } from "effect"

export const MaximumArchiveBytes = 64 * 1024 * 1024
export const MaximumArchiveUncompressedBytes = 256 * 1024 * 1024
export const MaximumArchiveEntries = 10_000
export const MaximumEncryptedArchiveBytes = MaximumArchiveBytes + 1_024

export const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
export type Sha256 = typeof Sha256.Type

const ArchiveByteLength = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MaximumArchiveBytes))

export const Archive = Schema.Struct({
  bytes: Schema.Uint8Array,
  contentDigest: Sha256,
  sizeBytes: ArchiveByteLength,
})
export type Archive = typeof Archive.Type

const EncodedArchiveContent = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(Math.ceil(MaximumArchiveBytes / 3) * 4),
)

export const EncodedArchive = Schema.Struct({
  content: EncodedArchiveContent,
  contentDigest: Sha256,
  sizeBytes: ArchiveByteLength,
})
export type EncodedArchive = typeof EncodedArchive.Type

export const StoredArchive = Schema.Struct({
  objectKey: Schema.NonEmptyString,
  contentDigest: Sha256,
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MaximumEncryptedArchiveBytes)),
  archiveDigest: Sha256,
  archiveSizeBytes: ArchiveByteLength,
  encryption: Schema.Literal("aes-256-gcm"),
})
export type StoredArchive = typeof StoredArchive.Type

export const WorkspaceSeedId = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,512}$/))
export type WorkspaceSeedId = typeof WorkspaceSeedId.Type

export class WorkspaceArchiveError extends Schema.TaggedError<WorkspaceArchiveError>()("WorkspaceArchiveError", {
  kind: Schema.Literals(["archive", "secret", "size"]),
  message: Schema.String,
}) {}
