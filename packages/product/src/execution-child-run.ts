import type { ExecutionRouteSnapshot } from "./execution-route-snapshot"
import type { Status } from "./execution-status"

export const AgentProfile = ["Oracle", "Librarian", "Painter", "Review", "ReadThread", "Surgeon", "Task"] as const
export type AgentProfile = (typeof AgentProfile)[number]
export type JoinPolicy = "all" | "first-success" | "quorum" | "best-effort"

export interface FanOutInput {
  readonly parentTurnId: string
  readonly fanOutId: string
  readonly workspace?: string
  readonly executionRoute: ExecutionRouteSnapshot
  readonly children: ReadonlyArray<{
    readonly childId: string
    readonly profile?: AgentProfile
    readonly prompt: string
  }>
  readonly maxConcurrency: number
  readonly join: JoinPolicy
  readonly quorum?: number
  readonly createdAt: number
}
export interface FanOutInspection {
  readonly fanOutId: string
  readonly parentTurnId: string
  readonly state: "joining" | "satisfied" | "failed" | "cancelled"
  readonly maxConcurrency: number
  readonly join: JoinPolicy
  readonly members: ReadonlyArray<{
    readonly childId: string
    readonly ordinal: number
    readonly state: Status
    readonly output?: unknown
    readonly error?: string
  }>
}
export interface ChildProjection {
  readonly parentTurnId: string
  readonly fanOutId: string
  readonly childId: string
  readonly ordinal: number
  readonly state: Status
  readonly output?: unknown
  readonly error?: string
}
export interface InvokeChildInput {
  readonly parentTurnId: string
  readonly childId: string
  readonly profile: AgentProfile | "Title"
  readonly prompt: string
}
export interface ChildEvent {
  readonly parentTurnId: string
  readonly childId: string
  readonly profile: AgentProfile | "Title"
  readonly type: "accepted"
}
