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
