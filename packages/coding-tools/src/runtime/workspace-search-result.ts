import { Schema } from "effect"

export interface WorkspaceSearchMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

export const WorkspaceSearchMatch = Schema.Struct({
  path: Schema.String,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  text: Schema.String,
})

export const WorkspaceSearchMatchesTruncation = Schema.Struct({
  kept: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
