import { OwnerSelection } from "@rika/product/thread-creation"
import { Schema } from "effect"
import { EncodedArchive, WorkspaceSeedId } from "./contract"

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })

export const WorkspaceSeedStageRequest = strict(
  Schema.Struct({
    owner: OwnerSelection,
    projectId: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(255))),
    archive: strict(EncodedArchive),
  }),
)
export type WorkspaceSeedStageRequest = typeof WorkspaceSeedStageRequest.Type
export type WorkspaceSeedStageRequestEncoded = typeof WorkspaceSeedStageRequest.Encoded

export const WorkspaceSeedStageReceipt = strict(Schema.Struct({ workspaceSeedId: WorkspaceSeedId }))
export type WorkspaceSeedStageReceipt = typeof WorkspaceSeedStageReceipt.Type
export type WorkspaceSeedStageReceiptEncoded = typeof WorkspaceSeedStageReceipt.Encoded
