import { Schema } from "effect"

export type ThreadItem = {
  readonly id: string
  readonly title: string
  readonly workspace: string
  readonly pinned: boolean
  readonly archived: boolean
  readonly status: "idle" | "error" | "queued" | "running"
  readonly unread: boolean
  readonly lastActivityAt: number
  readonly editTotals?: { readonly added: number; readonly modified: number; readonly removed: number }
}

export const ThreadItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  workspace: Schema.String,
  pinned: Schema.Boolean,
  archived: Schema.Boolean,
  status: Schema.Literals(["idle", "error", "queued", "running"]),
  unread: Schema.Boolean,
  lastActivityAt: Schema.Finite,
  editTotals: Schema.optionalKey(
    Schema.Struct({ added: Schema.Finite, modified: Schema.Finite, removed: Schema.Finite }),
  ),
})

const ThreadItems = Schema.Array(ThreadItem)
export const decodeThreadItems = (input: ReadonlyArray<unknown>): ReadonlyArray<ThreadItem> =>
  Schema.decodeUnknownSync(ThreadItems)(input)
