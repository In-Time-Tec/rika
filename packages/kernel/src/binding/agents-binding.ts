import { Pins } from "@batonfx/core"
import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "@batonfx/repl"
import { AdmitReceipt, ChildInspection, DirectoryEntry, InboxEntry, MessageReceipt } from "./agent-directory-contract"
import { AgentDirectoryUnavailable, AgentPort } from "./agent-port"
import { nested, NestedOperationFailed, operation, type Requirements } from "./nested-operation-envelope"

export const name = "agents"

const Failure = Schema.Union([AgentDirectoryUnavailable, NestedOperationFailed])

const profiles = ["Oracle", "Librarian", "Painter", "ReadThread", "Review", "Surgeon", "Task"] as const

const SpawnInput = Schema.Struct({
  profile: Schema.Literals(profiles),
  name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
  prompt: Schema.String.check(Schema.isNonEmpty()),
})
const InspectInput = Schema.Struct({ childRunId: Schema.String.check(Schema.isNonEmpty()) })
const InspectAllInput = Schema.Struct({
  childRunIds: Schema.Array(Schema.String.check(Schema.isNonEmpty())),
})
const CancelInput = Schema.Struct({
  childRunId: Schema.String.check(Schema.isNonEmpty()),
  reason: Schema.optionalKey(Schema.String),
})
const SendInput = Schema.Struct({
  to: Schema.String.check(Schema.isNonEmpty()),
  prompt: Schema.String.check(Schema.isNonEmpty()),
  inReplyTo: Schema.optionalKey(Schema.String),
})
const InboxInput = Schema.Struct({
  afterSequence: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))),
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(256)),
})
const Empty = Schema.Struct({})

/**
 * The key one spawn is admitted under. It names the profile and the host-assigned ordinal, never
 * cell input, so a replayed cell recomputes the same value and is recognised as the repeat it is.
 *
 * The cell it belongs to is named by the invocation Baton composes around this key, from the tool
 * call and the origin the host supplies. Repeating that identity here would embed it twice and grow
 * it at every level of nesting, which is what pushed a child's Session identity past its bound.
 */
const admissionKey = (profile: string, ordinal: number) => `${profile}#${ordinal}`

export const operations: ReadonlyArray<HostBindingRegistry.AnyOperation<AgentPort | Requirements>> = [
  operation({
    name: "spawn",
    input: SpawnInput,
    output: AdmitReceipt,
    failure: Failure,
    handle: (input) =>
      Effect.flatMap(AgentPort, (port) =>
        nested(
          { kind: "agents.spawn", payload: { profile: input.profile, prompt: input.prompt }, replayPolicy: "never" },
          port.spawn({ profile: input.profile, prompt: input.prompt, key: admissionKey(input.profile, 0) }),
        ),
      ),
  }),
  operation({
    name: "list",
    input: Empty,
    output: Schema.Array(ChildInspection),
    failure: Failure,
    handle: () => Effect.flatMap(AgentPort, (port) => port.list),
  }),
  operation({
    name: "inspect",
    input: InspectInput,
    output: ChildInspection,
    failure: Failure,
    handle: (input) => Effect.flatMap(AgentPort, (port) => port.inspect(input.childRunId)),
  }),
  operation({
    name: "inspectAll",
    input: InspectAllInput,
    output: Schema.Array(ChildInspection),
    failure: Failure,
    handle: (input) => Effect.flatMap(AgentPort, (port) => port.inspectAll(input.childRunIds)),
  }),
  operation({
    name: "cancel",
    input: CancelInput,
    output: Empty,
    failure: Failure,
    handle: (input) =>
      nested(
        { kind: "agents.cancel", payload: input, replayPolicy: "provider-idempotent" },
        Effect.flatMap(AgentPort, (port) =>
          port
            .cancel({ childRunId: input.childRunId, ...(input.reason === undefined ? {} : { reason: input.reason }) })
            .pipe(Effect.as({})),
        ),
      ),
  }),
  operation({
    name: "send",
    input: SendInput,
    output: MessageReceipt,
    failure: Failure,
    handle: (input) =>
      Effect.flatMap(AgentPort, (port) =>
        port.send({
          to: input.to,
          prompt: input.prompt,
          /**
           * A message is deduplicated by sender, recipient, and key together, so the key has to
           * change between two sends a cell makes to one agent while staying the same when that
           * cell is replayed. The message itself is the only thing with both properties.
           */
          idempotencyKey: Pins.digest({
            to: input.to,
            prompt: input.prompt,
            ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
          }),
          ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
        }),
      ),
  }),
  operation({
    name: "inbox",
    input: InboxInput,
    output: Schema.Array(InboxEntry),
    failure: Failure,
    handle: (input) => Effect.flatMap(AgentPort, (port) => port.inbox(input)),
  }),
  operation({
    name: "directory",
    input: Empty,
    output: Schema.Array(DirectoryEntry),
    failure: Failure,
    handle: () => Effect.flatMap(AgentPort, (port) => port.directory),
  }),
]

export const module: HostBindingRegistry.Module<AgentPort | Requirements> = { name, operations }
