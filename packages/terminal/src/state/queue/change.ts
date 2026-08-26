import type { QueueItem } from "./item"

export type QueueChange =
  | { readonly _tag: "Added"; readonly item: QueueItem; readonly position?: number }
  | { readonly _tag: "Updated"; readonly item: QueueItem }
  | { readonly _tag: "Removed"; readonly turnId: string }
