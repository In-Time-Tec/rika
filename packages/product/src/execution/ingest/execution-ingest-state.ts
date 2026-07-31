import type { ThreadId } from "../../thread/model/thread-record"
import type { TurnId } from "../../thread/model/turn-record"

export interface ExecutionIngestState {
  readonly threadId: ThreadId
  readonly rootTurnId: TurnId
  readonly streamId: string
  readonly patchRevision: number
  readonly terminal: boolean
}

export const initialExecutionIngestState = (
  threadId: ThreadId,
  rootTurnId: TurnId,
  streamId: string,
): ExecutionIngestState => ({ threadId, rootTurnId, streamId, patchRevision: 0, terminal: false })
