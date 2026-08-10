import { Context, Effect, Layer, Schema } from "effect"
import { AdmitReceipt, ChildInspection, DirectoryEntry, InboxEntry, MessageReceipt } from "./agent-directory-contract"
export { ChildSettlementInboxEntry, InboxEntry, MessageInboxEntry } from "./agent-directory-contract"

export class AgentDirectoryUnavailable extends Schema.TaggedErrorClass<AgentDirectoryUnavailable>()(
  "AgentDirectoryUnavailable",
  {
    reason: Schema.Literals(["parentage", "not-found", "terminal", "unauthorized", "bounded", "unavailable"]),
    message: Schema.String,
  },
) {}

/**
 * Rika's view of Baton's in-execution child and messaging operations.
 *
 * TEMPORARY BY CONSTRUCTION. `@batonfx/runtime` 0.19.2 does not export `ChildAdmission` or
 * `Messaging`, so this port declares the exact shapes of `AgentChildrenInterface` and
 * `AgentMessagingInterface` in order to bind `rika.agents` before those services ship. It MUST be
 * deleted and replaced by the real `AgentChildren` and `AgentMessaging` services once a released
 * `@batonfx/runtime` exports them; the operation bodies do not change when it is.
 *
 * Every operation derives parentage and sender identity from the ambient ToolContext inside the
 * adapter that implements this port, never from cell input, so no input carries a parentRunId or a
 * from address.
 */
export interface Interface {
  readonly spawn: (input: {
    readonly profile: string
    readonly prompt: string
    readonly key: string
  }) => Effect.Effect<typeof AdmitReceipt.Type, AgentDirectoryUnavailable>
  readonly list: Effect.Effect<ReadonlyArray<typeof ChildInspection.Type>, AgentDirectoryUnavailable>
  readonly inspect: (childRunId: string) => Effect.Effect<typeof ChildInspection.Type, AgentDirectoryUnavailable>
  readonly inspectAll: (
    childRunIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<typeof ChildInspection.Type>, AgentDirectoryUnavailable>
  readonly cancel: (input: {
    readonly childRunId: string
    readonly reason?: string | undefined
  }) => Effect.Effect<void, AgentDirectoryUnavailable>
  readonly send: (input: {
    readonly to: string
    readonly prompt: string
    readonly idempotencyKey: string
    readonly inReplyTo?: string | undefined
  }) => Effect.Effect<typeof MessageReceipt.Type, AgentDirectoryUnavailable>
  readonly inbox: (input: {
    readonly afterSequence?: number | undefined
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<typeof InboxEntry.Type>, AgentDirectoryUnavailable>
  readonly directory: Effect.Effect<ReadonlyArray<typeof DirectoryEntry.Type>, AgentDirectoryUnavailable>
}

export class AgentPort extends Context.Service<AgentPort, Interface>()("@rika/kernel/binding/agent-port/AgentPort") {}

export const layerTest = (implementation: Interface): Layer.Layer<AgentPort> =>
  Layer.succeed(AgentPort, AgentPort.of(implementation))
