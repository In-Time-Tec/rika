/* oxlint-disable anti-slop/no-unknown-parameters -- schema decoder accepts untrusted binding input at this boundary. */
import { Function, Schema } from "effect"
import { WorkspaceBinding as CanonicalWorkspaceBinding } from "@rika/execution"

const id = Schema.NonEmptyString

export const ExecutionTarget = Schema.Literals(["runner", "orb"])
export type ExecutionTarget = typeof ExecutionTarget.Type

export const WorkspacePlacement = Schema.Union([
  Schema.TaggedStruct("Runner", {
    checkoutFingerprint: id,
    workspaceId: id,
  }),
  Schema.TaggedStruct("Orb", {
    workspaceId: id,
    lineageId: id,
  }),
])
export type WorkspacePlacement = typeof WorkspacePlacement.Type

export const ThreadPartition = Schema.Struct({
  environment: id,
  ownerId: id,
  threadId: id,
  partition: id,
  rootSessionId: id,
  actorKey: Schema.Tuple([id, id, id]),
  target: ExecutionTarget,
})
export type ThreadPartition = typeof ThreadPartition.Type

export const ThreadExecutionBinding = Schema.Struct({
  partition: ThreadPartition,
  placement: WorkspacePlacement,
  /** Canonical execution-v2 fence admitted by the product execution authority. */
  workspaceBinding: CanonicalWorkspaceBinding,
})
export type ThreadExecutionBinding = typeof ThreadExecutionBinding.Type
export const decodeWorkspaceBinding = (value: unknown) => Schema.decodeUnknownSync(CanonicalWorkspaceBinding)(value)

const segment = (value: string) => encodeURIComponent(value)

/**
 * Derive the only Runtime namespace an authorized product Thread may use.
 *
 * This function is deliberately pure. A wake UUID, actor incarnation, Box id, or local path must never change the
 * namespace because a changed namespace opens a different object partition rather than recovering the existing one.
 */
export const threadPartition = (input: {
  readonly environment: string
  readonly ownerId: string
  readonly threadId: string
  readonly target: ExecutionTarget
}): ThreadPartition => {
  const environment = id.make(input.environment)
  const ownerId = id.make(input.ownerId)
  const threadId = id.make(input.threadId)
  const partition = `thread-${segment(threadId)}`
  const rootSessionId = `rika-v2:${segment(ownerId)}:${segment(threadId)}`
  return ThreadPartition.make({
    environment,
    ownerId,
    threadId,
    partition,
    rootSessionId,
    actorKey: [environment, ownerId, threadId],
    target: input.target,
  })
}

const samePartitionImpl = (left: ThreadPartition, right: ThreadPartition) =>
  left.environment === right.environment &&
  left.ownerId === right.ownerId &&
  left.threadId === right.threadId &&
  left.partition === right.partition &&
  left.rootSessionId === right.rootSessionId &&
  left.target === right.target

export const samePartition: {
  (left: ThreadPartition): (right: ThreadPartition) => ReturnType<typeof samePartitionImpl>
  (left: ThreadPartition, right: ThreadPartition): ReturnType<typeof samePartitionImpl>
} = Function.dual(2, samePartitionImpl)

export const threadIdFromRootSession = (rootSessionId: string) => {
  const prefix = "rika-v2:"
  if (!rootSessionId.startsWith(prefix)) return undefined
  const encoded = rootSessionId.slice(prefix.length)
  const separator = encoded.indexOf(":")
  if (separator < 1 || separator === encoded.length - 1) return undefined
  try {
    const ownerId = decodeURIComponent(encoded.slice(0, separator))
    const threadId = decodeURIComponent(encoded.slice(separator + 1))
    return ownerId.length === 0 || threadId.length === 0 ? undefined : { ownerId, threadId }
  } catch {
    return undefined
  }
}
