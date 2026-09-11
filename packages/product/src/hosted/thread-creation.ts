import { Schema } from "effect"
import { RunnerTarget } from "./executor/runner-registration"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })

export const OwnerSelection = Schema.Union([
  strict(Schema.Struct({ kind: Schema.Literal("personal") })),
  strict(Schema.Struct({ kind: Schema.Literal("organization"), organization_id: Schema.NonEmptyString })),
])
export type OwnerSelection = typeof OwnerSelection.Type
export type OwnerSelectionEncoded = typeof OwnerSelection.Encoded

const threadId = Schema.NonEmptyString.check(Schema.isMaxLength(512))
const common = {
  owner: OwnerSelection,
  threadId,
  projectId: Schema.optionalKey(Schema.NonEmptyString),
  archiveThreadId: Schema.optionalKey(Schema.NonEmptyString),
} as const

const RunnerThreadCreateRequest = strict(
  Schema.Struct({
    ...common,
    target: Schema.Literal("runner"),
    runnerTarget: RunnerTarget,
  }),
)
const OrbThreadCreateRequest = strict(
  Schema.Struct({
    ...common,
    target: Schema.Literal("orb"),
    workspaceSeedId: Schema.optionalKey(Schema.NonEmptyString),
  }),
)

export const ThreadCreateRequest = Schema.Union([RunnerThreadCreateRequest, OrbThreadCreateRequest])
export type ThreadCreateRequest = typeof ThreadCreateRequest.Type
export type ThreadCreateRequestEncoded = typeof ThreadCreateRequest.Encoded

export const ThreadCreationReceipt = strict(Schema.Struct({ threadId }))
export type ThreadCreationReceipt = typeof ThreadCreationReceipt.Type
export type ThreadCreationReceiptEncoded = typeof ThreadCreationReceipt.Encoded

export const ThreadArchiveRequest = strict(Schema.Struct({ threadId }))
export type ThreadArchiveRequest = typeof ThreadArchiveRequest.Type
export type ThreadArchiveRequestEncoded = typeof ThreadArchiveRequest.Encoded

export const ThreadArchiveReceipt = strict(Schema.Struct({ threadId, archived: Schema.Literal(true) }))
export type ThreadArchiveReceipt = typeof ThreadArchiveReceipt.Type
export type ThreadArchiveReceiptEncoded = typeof ThreadArchiveReceipt.Encoded
