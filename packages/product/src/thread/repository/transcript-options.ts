import type { PageCursor } from "../transcript/page"
import type { ThreadId } from "../model/record"

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly after?: PageCursor | undefined
  readonly limit?: number
  readonly projectionVersion?: number
  /** Oldest-first roots and member cards for reconstructing a bounded partial Turn. */
  readonly structuralTurnId?: import("../turn/record").TurnId
}
export interface ProjectionRecoveryCandidate {
  readonly threadId: ThreadId
  readonly turnId: import("../turn/record").TurnId
  readonly createdAt: number
}
