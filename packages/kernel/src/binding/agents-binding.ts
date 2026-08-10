import { Pins } from "@batonfx/core"
import { Clock, Effect, Schema } from "effect"
import type { HostBindingRegistry } from "@batonfx/repl"
import { AdmitReceipt, ChildInspection, DirectoryEntry, MailboxEntry, MessageReceipt } from "./agent-directory-contract"
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
/**
 * The longest a cell may wait for children, and the longest the host will wait however the cell
 * asks. A cell may only narrow it: a larger request is rejected at decode rather than quietly
 * clamped, so an author learns the bound instead of guessing at it. It stays far below the profile's
 * cell deadline, so waiting here can never be what ends the cell that waits.
 */
export const maxWaitMillis = 30_000

/** How often a wait re-reads durable child state. */
const pollIntervalMillis = 50

/** The statuses a child can no longer leave, matching Baton's own terminal rule. */
const terminalStatuses: ReadonlySet<typeof ChildInspection.Type.status> = new Set(["succeeded", "failed", "cancelled"])

const JoinInput = Schema.Struct({
  childRunIds: Schema.Array(Schema.String.check(Schema.isNonEmpty())).check(Schema.isMaxLength(64)),
  /**
   * How long the caller is willing to look, clamped rather than refused. A parent waiting on work
   * that runs for minutes asks for minutes, and rejecting that taught a model only that its call was
   * malformed — the clamp below already made a larger number safe.
   */
  waitMillis: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
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
const InboxInput = Schema.Struct({ limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(256)) })
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
  /**
   * Named for what it does: it reports, and `waitMillis` only says how long it is willing to look.
   *
   * Admission stays non-blocking, so a cell that wants a child's result waits here explicitly and
   * under a ceiling the host owns. A wait that elapses is not a failure — the children are reported
   * in whatever state they are in and the cell reads `status`, because a child still working is an
   * ordinary outcome rather than an error every authored cell must handle.
   */
  operation({
    name: "inspectAll",
    input: JoinInput,
    output: Schema.Array(ChildInspection),
    failure: Failure,
    handle: (input) =>
      Effect.flatMap(AgentPort, (port) => {
        const inspectAll = Effect.forEach(input.childRunIds, (childRunId) => port.inspect(childRunId))
        if (input.waitMillis === undefined) return inspectAll
        const deadline = Math.min(input.waitMillis, maxWaitMillis)
        const settled = (children: ReadonlyArray<typeof ChildInspection.Type>) =>
          children.every((child) => terminalStatuses.has(child.status))
        /**
         * The bound is elapsed time, read from the clock, rather than a count of polls. Each pass
         * reads durable state before it sleeps, so charging the budget only for the sleep would let
         * the wait outlast the ceiling a caller asked for by however long those reads took.
         */
        const poll = (
          expiresAt: number,
        ): Effect.Effect<ReadonlyArray<typeof ChildInspection.Type>, AgentDirectoryUnavailable> =>
          Effect.flatMap(inspectAll, (children) =>
            settled(children)
              ? Effect.succeed(children)
              : Effect.flatMap(Clock.currentTimeMillis, (now) =>
                  now >= expiresAt
                    ? Effect.succeed(children)
                    : Effect.sleep(Math.min(pollIntervalMillis, expiresAt - now)).pipe(
                        Effect.andThen(Effect.suspend(() => poll(expiresAt))),
                      ),
                ),
          )
        return Effect.flatMap(Clock.currentTimeMillis, (started) => poll(started + deadline))
      }),
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
    output: Schema.Array(MailboxEntry),
    failure: Failure,
    handle: (input) => Effect.flatMap(AgentPort, (port) => port.inbox(input.limit)),
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
