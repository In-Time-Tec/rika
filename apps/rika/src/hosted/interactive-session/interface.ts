import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { InteractiveSession } from "@rika/product/interactive-session"
import { OperationUnavailable } from "@rika/product/product-operation"
import type { Unit } from "@rika/transcript/transcript-unit"
import { Deferred, Effect, Schema } from "effect"
import type { HostedError } from "../contract"
import type { CommandMethods } from "./commands"
import type { Projection } from "./projection"

export const interactiveSessionInterface = (dependencies: {
  readonly commands: {
    readonly methods: CommandMethods
    readonly archiveCurrentThread: (operation: string) => InteractiveSession["archiveThread"]
  }
  readonly authority: () => Projection | undefined
  readonly connectionLoop: Effect.Effect<void, HostedError>
  readonly closed: Deferred.Deferred<void>
  readonly consumerAttached: () => boolean
  readonly attachConsumer: (dispatch: (event: InteractiveEvent) => void) => void
  readonly detachConsumer: () => void
  readonly unavailable: (operation: string, error: HostedError) => OperationUnavailable
  readonly quit: InteractiveSession["quit"]
  readonly createThread: (kind: "runner" | "orb", archiveThreadId?: string) => Effect.Effect<string, HostedError>
  readonly requestSelection: (threadId: string) => Effect.Effect<void, HostedError>
  readonly initialThreadId: string
  readonly previewThread: (threadId: string) => Effect.Effect<ReadonlyArray<Unit>, HostedError>
  readonly dispatch: (event: InteractiveEvent) => void
  readonly failure: (message: string) => HostedError
}) => {
  const selectCreated = (kind: "runner" | "orb", archiveThreadId?: string) =>
    Effect.gen(function* () {
      const threadId = yield* dependencies.createThread(kind, archiveThreadId)
      yield* dependencies.requestSelection(threadId)
    })
  const mappedSelection = (operation: string, threadId: string) =>
    dependencies.requestSelection(threadId).pipe(Effect.mapError((error) => dependencies.unavailable(operation, error)))
  return {
    events: (next) =>
      Effect.suspend(() => {
        if (dependencies.consumerAttached())
          return Effect.fail(
            OperationUnavailable.make({
              operation: "InteractiveSession.events",
              message: "Interactive session already has an event consumer",
            }),
          )
        dependencies.attachConsumer(next)
        return Effect.raceFirst(dependencies.connectionLoop, Deferred.await(dependencies.closed)).pipe(
          Effect.ensuring(Effect.sync(dependencies.detachConsumer)),
          Effect.mapError((error) => dependencies.unavailable("InteractiveSession.events", error)),
        )
      }),
    currentView: () => dependencies.authority()?.view,
    projectionCheckpoint: (turnId) =>
      [...(dependencies.authority()?.authorizations.values() ?? [])].find(
        (authorization) => String(authorization.turnId) === turnId,
      )?.checkpoint,
    ...dependencies.commands.methods,
    quit: dependencies.quit,
    newThread: selectCreated("runner").pipe(
      Effect.mapError((error) => dependencies.unavailable("InteractiveSession.newThread", error)),
    ),
    newOrbThread: selectCreated("orb").pipe(
      Effect.mapError((error) => dependencies.unavailable("InteractiveSession.newOrbThread", error)),
    ),
    archiveThread: dependencies.commands.archiveCurrentThread("InteractiveSession.archiveThread"),
    archiveAndNewThread: Effect.suspend(() => selectCreated("runner", dependencies.authority()?.threadId)).pipe(
      Effect.mapError((error) =>
        Schema.is(OperationUnavailable)(error)
          ? error
          : dependencies.unavailable("InteractiveSession.archiveAndNewThread", error),
      ),
    ),
    selectThread: (threadId) => mappedSelection("InteractiveSession.selectThread", threadId),
    readQueue: (threadId) =>
      Effect.suspend(() =>
        dependencies.authority()?.threadId === threadId
          ? dependencies.requestSelection(threadId)
          : Effect.fail(dependencies.failure("Queue refresh requires the selected Thread")),
      ).pipe(Effect.mapError((error) => dependencies.unavailable("InteractiveSession.readQueue", error))),
    previewThread: (threadId, requestId) =>
      dependencies.previewThread(threadId).pipe(
        Effect.tap((units) =>
          Effect.sync(() => dependencies.dispatch({ _tag: "ThreadPreviewLoaded", threadId, requestId, units })),
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            dependencies.dispatch({ _tag: "ThreadPreviewFailed", threadId, requestId, message: error.message }),
          ),
        ),
      ),
    reopenThread: Effect.suspend(() =>
      mappedSelection(
        "InteractiveSession.reopenThread",
        dependencies.authority()?.threadId ?? dependencies.initialThreadId,
      ),
    ),
  } satisfies InteractiveSession
}
