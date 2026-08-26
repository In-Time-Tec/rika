import type { PageCursor } from "../transcript/page"
import type { ThreadId } from "../model/record"

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly after?: PageCursor | undefined
  readonly limit?: number
  readonly projectionVersion?: number
}
export interface ProjectionRecoveryCandidate {
  readonly threadId: ThreadId
  readonly turnId: import("../turn/record").TurnId
}
