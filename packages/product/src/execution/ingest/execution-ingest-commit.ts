import type { ThreadId } from "../../thread/model/thread-record"
import type { TurnId } from "../../thread/model/turn-record"

export interface ExecutionIngestCommit {
  readonly threadId: ThreadId
  readonly rootTurnId: TurnId
  readonly revision: number
  readonly terminal: boolean
  readonly usageChanged: boolean
  readonly refolded: boolean
}

export const committedExecution = (
  threadId: ThreadId,
  rootTurnId: TurnId,
  revision: number,
  terminal: boolean,
  usageChanged: boolean,
  refolded: boolean,
): ExecutionIngestCommit => ({ threadId, rootTurnId, revision, terminal, usageChanged, refolded })
