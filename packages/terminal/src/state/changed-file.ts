import { Schema } from "effect"

export const ChangedFile = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  added: Schema.optional(Schema.Finite),
  removed: Schema.optional(Schema.Finite),
})
export type ChangedFile = typeof ChangedFile.Type

const sameChangedFiles = (left: ReadonlyArray<ChangedFile>, right: ReadonlyArray<ChangedFile>): boolean =>
  left.length === right.length &&
  left.every((file, index) => {
    const candidate = right[index]
    return (
      candidate !== undefined &&
      file.path === candidate.path &&
      file.status === candidate.status &&
      file.added === candidate.added &&
      file.removed === candidate.removed
    )
  })

export const changedFiles = { same: sameChangedFiles }
