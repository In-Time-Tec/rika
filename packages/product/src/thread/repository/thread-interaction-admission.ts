import { Schema } from "effect"
import { ExecutionRouteSnapshot } from "../../execution/contract/execution-route-snapshot"
import { ThreadId } from "../model/thread-record"
import { TurnId } from "../model/turn-record"

interface Limits {
  readonly maximumDepth: number
  readonly maximumAdmissions: number
  readonly maximumWorkspaceActive: number
  readonly queueCapacity: number
}

interface TurnInput {
  readonly turnId: TurnId
  readonly prompt: string
  readonly executionRoute: ExecutionRouteSnapshot
}

export interface Invocation {
  readonly invocationDigest: string
  readonly schemaInputDigest: string
  readonly sourceThreadId: ThreadId
  readonly sourceRootTurnId: TurnId
  readonly now: number
}

export interface CreateThreadInput extends Invocation, Limits, TurnInput {
  readonly threadId: ThreadId
  readonly title: string
  readonly resultDelivery: "manual" | "reply"
  readonly threadCreationDepth: number
}

export interface AppendThreadMessageInput extends Invocation, Limits, TurnInput {
  readonly targetThreadId: ThreadId
  readonly resultDelivery: "manual" | "reply"
  readonly threadCreationDepth: number
}

export interface BindThreadControlInput extends Invocation {
  readonly targetThreadId: ThreadId
}
