import type { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import type { PromptPart } from "@rika/product/execution-request"
import type { ThreadId } from "@rika/product/thread-record"
import type { TurnAuthor, TurnLineage } from "@rika/product/thread-relationship"
import type { TurnId } from "@rika/product/turn-record"

export interface CreateInput {
  readonly id: TurnId
  readonly threadId: ThreadId
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly executionRoute: ExecutionRouteSnapshot
  readonly reviewFanOutId?: string
  readonly author?: TurnAuthor
  readonly lineage?: TurnLineage
  readonly queueCapacity: number
  readonly now: number
}
