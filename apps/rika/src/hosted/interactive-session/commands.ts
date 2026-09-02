import type { MutatingThreadCommand, WorkspacePlacement } from "@rika/product/client-protocol"
import { CommandId, IdempotencyKey, ThreadId, ThreadVersion } from "@rika/product/hosted-model"
import type { InteractiveSession } from "@rika/product/interactive-session"
import { OperationUnavailable } from "@rika/product/product-operation"
import * as Turn from "@rika/product/turn-record"
import { Deferred, Effect } from "effect"
import { HostedError } from "../contract"
import type { CommandOutcome, PhysicalConnection, Rejected } from "./connection"
import type {
  CancellationTarget,
  PreparedAttachment,
  Projection,
  SubmitPromptAttachment,
  SubmitPromptCommand,
} from "./projection"

type PendingSubmission = {
  readonly commandId: Deferred.Deferred<string, OperationUnavailable>
  sending: boolean
}

export type CommandMethods = Pick<
  InteractiveSession,
  | "submit"
  | "shell"
  | "editQueued"
  | "dequeue"
  | "steerQueued"
  | "steer"
  | "approveAuthorization"
  | "denyAuthorization"
  | "interruptAndSend"
  | "cancel"
>

export const interactiveSessionCommands = (dependencies: {
  readonly authority: () => Projection | undefined
  readonly replaceAuthority: (expected: Projection, replacement: Projection) => boolean
  readonly awaitConnection: Effect.Effect<PhysicalConnection, HostedError>
  readonly connectionLost: (connection: PhysicalConnection) => Effect.Effect<void>
  readonly randomId: Effect.Effect<string, HostedError>
  readonly nextCommandId: (prefix: string) => Effect.Effect<string, OperationUnavailable>
  readonly setUnknownActivity: Effect.Effect<void>
  readonly setPromptWorkspaceActivity: (workspace: WorkspacePlacement) => Effect.Effect<void>
  readonly refreshThreads: Effect.Effect<void>
  readonly closed: Deferred.Deferred<void>
  readonly stopped: () => boolean
  readonly failure: (message: string) => HostedError
  readonly unavailable: (operation: string, error: HostedError) => OperationUnavailable
}) => {
  const latestSubmitCommandIds = new Map<string, string>()
  const pendingSubmitCommandIds = new Map<string, Map<string, PendingSubmission>>()
  const unsupported = (operation: string, message = "This action is unavailable in the current Thread") =>
    Effect.fail(OperationUnavailable.make({ operation, message }))
  const pendingSubmission = (threadId: string, submissionId: string) => {
    let submissions = pendingSubmitCommandIds.get(threadId)
    if (submissions === undefined) {
      submissions = new Map()
      pendingSubmitCommandIds.set(threadId, submissions)
    }
    if (submissions.has(submissionId)) return undefined
    const created = { commandId: Deferred.makeUnsafe<string, OperationUnavailable>(), sending: false }
    submissions.set(submissionId, created)
    return created
  }
  const forgetSubmission = (threadId: string, submissionId: string) =>
    Effect.sync(() => {
      const submissions = pendingSubmitCommandIds.get(threadId)
      submissions?.delete(submissionId)
      if (submissions?.size === 0) pendingSubmitCommandIds.delete(threadId)
    })
  const admittedOutcome = (outcome: CommandOutcome) =>
    outcome._tag === "CommandAdmitted" || outcome._tag === "CommandAccepted"
  const staleOutcome = (
    outcome: CommandOutcome,
    retry: boolean,
  ): outcome is Extract<CommandOutcome, { readonly _tag: "CommandRejected" }> & {
    readonly currentThreadVersion: NonNullable<Rejected["currentThreadVersion"]>
  } =>
    outcome._tag === "CommandRejected" &&
    retry &&
    outcome.reason === "stale-version" &&
    outcome.currentThreadVersion !== undefined
  const mutate = (
    operation: string,
    commandId: string,
    make: (threadId: ThreadId, version: string) => MutatingThreadCommand,
    completeOnAdmission = false,
    onSending: Effect.Effect<void> = Effect.void,
    onRejected: (outcome: Rejected) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const admitted = dependencies.authority()
      if (admitted === undefined) return yield* dependencies.failure("Thread authority is unavailable")
      const threadId = admitted.threadId
      const attempt = (retryStaleVersion: boolean): Effect.Effect<void, HostedError> =>
        Effect.suspend(() => {
          if (dependencies.stopped()) return Effect.fail(dependencies.failure("Interactive session is closed"))
          const projection = dependencies.authority()
          if (projection === undefined || projection.threadId !== threadId)
            return Effect.fail(dependencies.failure("Thread authority changed during command execution"))
          const command = make(ThreadId.make(threadId), projection.version)
          const sendUntilKnown = (): Effect.Effect<CommandOutcome, HostedError> =>
            Effect.gen(function* () {
              const physical = yield* dependencies.awaitConnection
              const requestId = `${commandId}:${yield* dependencies.randomId}`
              const result = yield* Effect.result(
                physical.command(requestId, command, completeOnAdmission, onSending, (rejected) =>
                  rejected.reason === "unavailable" ||
                  (retryStaleVersion &&
                    rejected.reason === "stale-version" &&
                    rejected.currentThreadVersion !== undefined)
                    ? Effect.void
                    : onRejected(rejected),
                ),
              )
              if (result._tag === "Success") {
                if (result.success._tag !== "CommandRejected" || result.success.reason !== "unavailable")
                  return result.success
                yield* dependencies.setUnknownActivity
                yield* Effect.sleep("250 millis")
                return yield* sendUntilKnown()
              }
              if (result.failure.kind === "protocol") return yield* result.failure
              yield* dependencies.connectionLost(physical)
              return yield* sendUntilKnown()
            })
          return sendUntilKnown().pipe(
            Effect.flatMap((outcome) => {
              if (admittedOutcome(outcome)) {
                return Effect.gen(function* () {
                  if (
                    command._tag === "SubmitPrompt" &&
                    outcome._tag === "CommandAdmitted" &&
                    outcome.workspace !== undefined
                  )
                    yield* dependencies.setPromptWorkspaceActivity(outcome.workspace)
                  const committed = dependencies.authority()
                  if (committed?.threadId === threadId && BigInt(outcome.threadVersion) > BigInt(committed.version))
                    dependencies.replaceAuthority(committed, { ...committed, version: String(outcome.threadVersion) })
                  if (outcome._tag !== "CommandAccepted" && !completeOnAdmission)
                    return yield* dependencies.failure(
                      "Thread command completion was not pushed after durable admission",
                    )
                })
              }
              if (staleOutcome(outcome, retryStaleVersion)) {
                const committed = dependencies.authority()
                if (committed?.threadId !== threadId)
                  return Effect.fail(dependencies.failure("Thread authority changed during command retry"))
                if (BigInt(outcome.currentThreadVersion) > BigInt(committed.version))
                  dependencies.replaceAuthority(committed, {
                    ...committed,
                    version: String(outcome.currentThreadVersion),
                  })
                return attempt(false)
              }
              const markConflict = outcome.reason === "conflict" ? dependencies.setUnknownActivity : Effect.void
              return markConflict.pipe(
                Effect.andThen(
                  HostedError.make({
                    kind: outcome.reason === "forbidden" ? "denied" : "protocol",
                    message: outcome.message,
                  }),
                ),
              )
            }),
          )
        })
      yield* attempt(true)
    }).pipe(Effect.mapError((error) => dependencies.unavailable(operation, error)))

  const activeTurnId = () =>
    dependencies
      .authority()
      ?.view.turns.findLast(
        (entry) =>
          entry.turn.status === "accepted" ||
          entry.turn.status === "running" ||
          entry.turn.status === "cancelling" ||
          entry.turn.status === "waiting",
      )?.turn.id
  const command = (
    operation: string,
    prefix: string,
    make: (threadId: ThreadId, version: string, commandId: string) => MutatingThreadCommand,
  ) =>
    Effect.gen(function* () {
      const commandId = yield* dependencies.nextCommandId(prefix)
      yield* mutate(operation, commandId, (threadId, version) => make(threadId, version, commandId))
    })
  const versioned = (commandId: string, threadId: ThreadId, version: string) => ({
    threadId,
    commandId: CommandId.make(commandId),
    idempotencyKey: IdempotencyKey.make(commandId),
    expectedThreadVersion: ThreadVersion.make(version),
  })
  const cancellationTarget = (
    requested: NonNullable<Parameters<InteractiveSession["cancel"]>[0]>,
    selectedThreadId: string,
  ) =>
    Effect.gen(function* () {
      const targetTurnId = requested.turnId ?? (requested.submissionId === undefined ? activeTurnId() : undefined)
      if (targetTurnId !== undefined) return { _tag: "Turn" as const, turnId: Turn.TurnId.make(targetTurnId) }
      let targetCommandId = latestSubmitCommandIds.get(selectedThreadId)
      if (requested.submissionId !== undefined) {
        const pending = pendingSubmitCommandIds.get(selectedThreadId)?.get(requested.submissionId)
        if (pending === undefined) return yield* unsupported("InteractiveSession.cancel")
        targetCommandId = yield* Effect.raceFirst(
          Deferred.await(pending.commandId),
          Deferred.await(dependencies.closed).pipe(Effect.andThen(unsupported("InteractiveSession.cancel"))),
        )
      }
      return targetCommandId === undefined
        ? undefined
        : { _tag: "Command" as const, commandId: CommandId.make(targetCommandId) }
    })
  const methods: CommandMethods = {
    submit: (prompt, mode, parts, _tuning, submissionId) =>
      Effect.gen(function* () {
        const selectedThreadId = dependencies.authority()?.threadId
        if (selectedThreadId === undefined) return yield* unsupported("InteractiveSession.submit")
        const commandId = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const pending = submissionId === undefined ? undefined : pendingSubmission(selectedThreadId, submissionId)
            if (submissionId !== undefined && pending === undefined)
              return yield* OperationUnavailable.make({
                operation: "InteractiveSession.submit",
                message: "Submission identity is already pending",
              })
            const allocated = yield* dependencies
              .nextCommandId("submit")
              .pipe(
                Effect.tapError((error) =>
                  pending === undefined
                    ? Effect.void
                    : Deferred.fail(pending.commandId, error).pipe(
                        Effect.andThen(forgetSubmission(selectedThreadId, submissionId!)),
                        Effect.asVoid,
                      ),
                ),
              )
            if (pending !== undefined) yield* Deferred.succeed(pending.commandId, allocated)
            return allocated
          }),
        )
        const attachments = parts?.flatMap((part) => {
          if (part.type !== "image") return []
          const attachment: SubmitPromptAttachment =
            part.filename === undefined
              ? { mediaType: part.mediaType, data: part.data }
              : { mediaType: part.mediaType, data: part.data, filename: part.filename }
          return [attachment]
        })
        yield* mutate(
          "InteractiveSession.submit",
          commandId,
          (threadId, version) => {
            latestSubmitCommandIds.set(String(threadId), commandId)
            const submit: SubmitPromptCommand = {
              _tag: "SubmitPrompt",
              ...versioned(commandId, threadId, version),
              text: prompt,
            }
            if (submissionId !== undefined) submit.submissionId = submissionId
            if (mode !== undefined) submit.mode = mode
            if (attachments !== undefined && attachments.length > 0) submit.attachments = attachments
            return submit
          },
          true,
          submissionId === undefined
            ? Effect.void
            : Effect.sync(() => {
                const pending = pendingSubmitCommandIds.get(selectedThreadId)?.get(submissionId)
                if (pending !== undefined) pending.sending = true
              }),
          () => (submissionId === undefined ? Effect.void : forgetSubmission(selectedThreadId, submissionId)),
        ).pipe(
          Effect.ensuring(
            submissionId === undefined
              ? Effect.void
              : Effect.sync(() => {
                  const submissions = pendingSubmitCommandIds.get(selectedThreadId)
                  if (submissions?.get(submissionId)?.sending !== false) return
                  submissions.delete(submissionId)
                  if (submissions.size === 0) pendingSubmitCommandIds.delete(selectedThreadId)
                }),
          ),
        )
      }),
    shell: () => unsupported("InteractiveSession.shell", "Shell commands are unavailable in this Thread"),
    editQueued: (turnId, prompt) =>
      command("InteractiveSession.editQueued", "edit-queued", (threadId, version, commandId) => ({
        _tag: "EditQueued",
        ...versioned(commandId, threadId, version),
        turnId: Turn.TurnId.make(turnId),
        prompt,
      })),
    dequeue: (turnId) =>
      command("InteractiveSession.dequeue", "dequeue", (threadId, version, commandId) => ({
        _tag: "Dequeue",
        ...versioned(commandId, threadId, version),
        turnId: Turn.TurnId.make(turnId),
      })),
    steerQueued: (turnId, text, requestId) =>
      mutate("InteractiveSession.steerQueued", requestId, (threadId, version) => ({
        _tag: "Steer",
        ...versioned(requestId, threadId, version),
        text,
        targetTurnId: Turn.TurnId.make(turnId),
      })),
    steer: (text, requestId, turnId) => {
      const targetTurnId = turnId ?? activeTurnId()
      return targetTurnId === undefined
        ? unsupported("InteractiveSession.steer")
        : mutate("InteractiveSession.steer", requestId, (threadId, version) => ({
            _tag: "Steer",
            ...versioned(requestId, threadId, version),
            text,
            targetTurnId: Turn.TurnId.make(targetTurnId),
          }))
    },
    approveAuthorization: (turnId, authorizationId) => {
      const pending = dependencies.authority()?.authorizations.get(`${turnId}:${authorizationId}`)
      if (pending === undefined) return unsupported("InteractiveSession.approveAuthorization")
      const commandId = `approve:${turnId}:${authorizationId}`
      return mutate("InteractiveSession.approveAuthorization", commandId, (threadId, version) => ({
        _tag: "Approve",
        ...versioned(commandId, threadId, version),
        turnId: pending.turnId,
        authorizationId,
        checkpoint: pending.checkpoint,
      }))
    },
    denyAuthorization: (turnId, authorizationId) => {
      const pending = dependencies.authority()?.authorizations.get(`${turnId}:${authorizationId}`)
      if (pending === undefined) return unsupported("InteractiveSession.denyAuthorization")
      const commandId = `deny:${turnId}:${authorizationId}`
      return mutate("InteractiveSession.denyAuthorization", commandId, (threadId, version) => ({
        _tag: "Deny",
        ...versioned(commandId, threadId, version),
        turnId: pending.turnId,
        authorizationId,
        checkpoint: pending.checkpoint,
      }))
    },
    interruptAndSend: (prompt, requestedTurnId) => {
      const targetTurnId = requestedTurnId ?? activeTurnId()
      return targetTurnId === undefined
        ? unsupported("InteractiveSession.interruptAndSend")
        : command("InteractiveSession.interruptAndSend", "interrupt", (threadId, version, commandId) => ({
            _tag: "InterruptAndSend",
            ...versioned(commandId, threadId, version),
            text: prompt,
            targetTurnId: Turn.TurnId.make(targetTurnId),
          }))
    },
    cancel: (requested = {}) =>
      Effect.gen(function* () {
        const selectedThreadId = requested.threadId ?? dependencies.authority()?.threadId
        if (selectedThreadId === undefined) return yield* unsupported("InteractiveSession.cancel")
        if (dependencies.authority()?.threadId !== selectedThreadId)
          return yield* dependencies.unavailable(
            "InteractiveSession.cancel",
            dependencies.failure("Thread authority changed before cancellation"),
          )
        const target: CancellationTarget | undefined = yield* cancellationTarget(requested, selectedThreadId)
        if (target === undefined) return yield* unsupported("InteractiveSession.cancel")
        const commandId = yield* dependencies.nextCommandId("cancel")
        if (dependencies.authority()?.threadId !== selectedThreadId)
          return yield* dependencies.unavailable(
            "InteractiveSession.cancel",
            dependencies.failure("Thread authority changed during cancellation"),
          )
        yield* mutate(
          "InteractiveSession.cancel",
          commandId,
          (threadId, version) => ({ _tag: "Cancel", ...versioned(commandId, threadId, version), target }),
          true,
        )
        if (requested.submissionId !== undefined) yield* forgetSubmission(selectedThreadId, requested.submissionId)
      }),
  }
  const reconcilePendingSubmissions = (prepared: PreparedAttachment) =>
    Effect.uninterruptible(
      Effect.forEach(prepared.attachment.events, (event) => {
        const value = event.event
        return (value._tag === "SubmissionAdmitted" || value._tag === "SubmissionRejected") &&
          value.submissionId !== undefined
          ? forgetSubmission(String(prepared.attachment.threadId), value.submissionId)
          : Effect.void
      }).pipe(Effect.asVoid),
    )
  const archiveCurrentThread = (operation: string) =>
    command(operation, "archive", (threadId, version, commandId) => ({
      _tag: "ArchiveThread",
      ...versioned(commandId, threadId, version),
    })).pipe(Effect.andThen(dependencies.refreshThreads))
  return { methods, reconcilePendingSubmissions, reconcileSubmission: forgetSubmission, archiveCurrentThread }
}
