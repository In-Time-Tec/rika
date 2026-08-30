import {
  hostedThreadSnapshotMatches,
  type HostedThreadSnapshot,
  interactiveEventThreadId,
  type MutatingThreadCommand,
  type ServerFrame,
  type ClientCommand,
} from "@rika/product/client-protocol"
import type * as InteractiveConnection from "@rika/product/interactive-connection"
import { OperationUnavailable } from "@rika/product/product-operation"
import * as ThreadView from "@rika/product/thread-view"
import { HostedError } from "../contract"
import { Option, Schema } from "effect"

type Payload = ServerFrame["payload"]
export type Snapshot = Extract<Payload, { readonly _tag: "ThreadSnapshot" }>
export type Attachment = Extract<Payload, { readonly _tag: "ThreadAttached" }>
export type Preview = Extract<Payload, { readonly _tag: "ThreadPreview" }>
export type SnapshotProjection = Pick<Snapshot, "threadId" | "threadVersion" | "cursor" | "snapshot">
export type CancellationTarget = Extract<MutatingThreadCommand, { readonly _tag: "Cancel" }>["target"]
type Mutable<T> = { -readonly [P in keyof T]: T[P] }
export type SubmitPromptCommand = Mutable<Extract<ClientCommand, { readonly _tag: "SubmitPrompt" }>>
export type SubmitPromptAttachment = NonNullable<SubmitPromptCommand["attachments"]>[number]

const encodeThreadView = Schema.encodeSync(Schema.fromJsonString(ThreadView.ThreadViewSnapshot))

const failure = (message: string) => HostedError.make({ kind: "network", message })

export type PreparedAttachment = {
  readonly attachment: Attachment
  readonly checkpoint: HostedThreadSnapshot | undefined
  readonly baseCursor: bigint
  readonly terminalCursor: bigint
  readonly representedVersion: bigint
  readonly view: ThreadView.ThreadViewSnapshot
}

export type Projection = {
  readonly threadId: string
  readonly view: ThreadView.ThreadViewSnapshot
  readonly authorizations: ReadonlyMap<string, HostedThreadSnapshot["pendingAuthorizations"][number]>
  readonly target: "runner" | "orb"
  readonly workspace: HostedThreadSnapshot["workspace"]
  readonly activity: InteractiveConnection.Activity
  readonly participants: number
  readonly committedCursor: string
  readonly checkpointCursor: string
  readonly version: string
  readonly representedVersion: string
  readonly deliveredCursor: string
  readonly deliveredFingerprint: string | undefined
}

export type SelectionState =
  | { readonly _tag: "Attached"; readonly projection: Projection }
  | {
      readonly _tag: "Loading"
      readonly token: object
      readonly threadId: string
      readonly authority: Projection | undefined
    }

type AttachmentValidation =
  | { readonly _tag: "Invalid"; readonly error: HostedError }
  | { readonly _tag: "Valid"; readonly prepared: PreparedAttachment }

type AttachmentEventValidation =
  | { readonly _tag: "Invalid"; readonly message: string }
  | { readonly _tag: "Valid"; readonly representedVersion: bigint }

const invalidAttachment = (message: string): AttachmentValidation => ({ _tag: "Invalid", error: failure(message) })

const validateAttachmentEvents = (
  attachment: Attachment,
  threadId: string,
  previous: Projection | undefined,
): AttachmentEventValidation => {
  if (
    attachment.events.some((event) => {
      const eventThreadId = interactiveEventThreadId(event.event)
      return String(event.threadId) !== threadId || (eventThreadId !== undefined && eventThreadId !== threadId)
    })
  )
    return { _tag: "Invalid", message: "Thread attachment event identity did not match its response" }
  let expectedCursor = BigInt(attachment.baseCursor) + 1n
  let representedVersion = BigInt(attachment.checkpoint?.threadVersion ?? previous!.representedVersion)
  for (const event of attachment.events) {
    if (BigInt(event.cursor) !== expectedCursor)
      return { _tag: "Invalid", message: "Thread attachment replay was not contiguous" }
    const eventVersion = BigInt(event.threadVersion)
    if (eventVersion < representedVersion)
      return { _tag: "Invalid", message: "Thread attachment version regressed" }
    representedVersion = eventVersion
    expectedCursor += 1n
  }
  if (expectedCursor - 1n !== BigInt(attachment.cursor))
    return { _tag: "Invalid", message: "Thread attachment terminal cursor was not represented" }
  if (representedVersion > BigInt(attachment.threadVersion))
    return { _tag: "Invalid", message: "Thread attachment represented version exceeded its terminal version" }
  return { _tag: "Valid", representedVersion }
}

const projectAttachmentView = (attachment: Attachment, previous: Projection | undefined) => {
  let view = ThreadView.fromSnapshot(attachment.checkpoint?.snapshot.view ?? previous!.view)
  if (view._tag === "Failure") return failure("Thread attachment checkpoint was invalid")
  for (const event of attachment.events) {
    if (event.event._tag === "ThreadViewSnapshot") view = ThreadView.fromSnapshot(event.event.snapshot)
    else if (event.event._tag === "ThreadViewPatch") {
      const applied = view.success.apply(event.event.patch)
      if (applied._tag === "Failure") return failure("Thread attachment view patch was invalid")
    }
    if (view._tag === "Failure") return failure("Thread attachment view snapshot was invalid")
  }
  return view.success.snapshot()
}

const prepareAttachment = (attachment: Attachment, previous: Projection | undefined): AttachmentValidation => {
  const threadId = String(attachment.threadId)
  const checkpoint = attachment.checkpoint
  if (checkpoint !== undefined && !hostedThreadSnapshotMatches(checkpoint.snapshot, threadId))
    return invalidAttachment("Thread attachment checkpoint identity did not match its response")
  const eventValidation = validateAttachmentEvents(attachment, threadId, previous)
  if (eventValidation._tag === "Invalid") return invalidAttachment(eventValidation.message)
  const baseCursor = BigInt(attachment.baseCursor)
  const terminalCursor = BigInt(attachment.cursor)
  if (baseCursor > terminalCursor)
    return { _tag: "Invalid", error: failure("Thread attachment base exceeded its terminal cursor") }
  if (checkpoint === undefined && (previous?.threadId !== threadId || BigInt(previous.deliveredCursor) !== baseCursor))
    return { _tag: "Invalid", error: failure("Thread attachment tail has no matching local checkpoint") }
  if (checkpoint !== undefined && BigInt(checkpoint.cursor) !== baseCursor)
    return { _tag: "Invalid", error: failure("Thread attachment checkpoint did not match its replay base") }
  const view = projectAttachmentView(attachment, previous)
  if (Schema.is(HostedError)(view)) return { _tag: "Invalid", error: view }
  return {
    _tag: "Valid",
    prepared: {
      attachment,
      checkpoint: checkpoint?.snapshot,
      baseCursor,
      terminalCursor,
      representedVersion: eventValidation.representedVersion,
      view,
    },
  }
}

const ErrorMessage = Schema.Struct({ message: Schema.String })

const unavailable = <E>(operation: string, error: E) => {
  const parsed = Schema.decodeUnknownOption(ErrorMessage)(error)
  return OperationUnavailable.make({
    operation,
    message: Option.isSome(parsed) ? parsed.value.message : String(error),
  })
}

const threadViewFromHostedSnapshot = (snapshot: HostedThreadSnapshot): ThreadView.ThreadViewSnapshot => snapshot.view

export const AttachmentProjection = {
  encodeThreadView,
  failure,
  prepareAttachment,
  threadViewFromHostedSnapshot,
  unavailable,
}
