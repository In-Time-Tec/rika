import type { InteractiveSession } from "@rika/product/interactive-session"
import * as ProductOperation from "@rika/product/product-operation"
import type * as ServerInteractiveConnection from "@rika/product/server-interactive-connection"
import type * as ServerService from "@rika/product/server-service"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Ref } from "effect"
import { makePhysicalFeed } from "../src/transport/client/server-client-feed"
import { makeInteractiveSupervisor } from "../src/transport/client/server-client-reconnect"
import { makeInteractiveSession } from "../src/transport/client/server-client-session"

describe("server client interactive session", () => {
  it.effect("forwards thread archive commands over the command invocation boundary", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<unknown>>([])
      const session = makeInteractiveSession({
        feed: yield* makePhysicalFeed("session", "generation", 16),
        closed: yield* Deferred.make<void>(),
        invoke: (command) => Ref.update(commands, (current) => [...current, command]),
        write: () => Effect.void,
        unavailable: (message) => ProductOperation.OperationUnavailable.make({ operation: "server client", message }),
        traceEvent: () => Effect.void,
      })

      yield* session.archiveThread
      yield* session.archiveAndNewThread

      expect(yield* Ref.get(commands)).toEqual([{ _tag: "ArchiveThread" }, { _tag: "ArchiveAndNewThread" }])
    }),
  )

  it.effect("propagates an unacknowledged archive command", () =>
    Effect.gen(function* () {
      const unavailable = ProductOperation.OperationUnavailable.make({
        operation: "ArchiveAndNewThread",
        message: "archive was not acknowledged",
      })
      const session = makeInteractiveSession({
        feed: yield* makePhysicalFeed("session", "generation", 16),
        closed: yield* Deferred.make<void>(),
        invoke: () => Effect.fail(unavailable),
        write: () => Effect.void,
        unavailable: (message) => ProductOperation.OperationUnavailable.make({ operation: "server client", message }),
        traceEvent: () => Effect.void,
      })

      const result = yield* Effect.result(session.archiveAndNewThread)

      expect(result._tag).toBe("Failure")
      expect(result._tag === "Failure" ? result.failure : undefined).toBe(unavailable)
    }),
  )

  it.live("preserves the selected thread across reconnect when archive-and-new is not acknowledged", () =>
    Effect.gen(function* () {
      const disconnect = yield* Deferred.make<void>()
      const reattachedSelection = yield* Deferred.make<string>()
      const logicalClosed = yield* Deferred.make<void>()
      const observed = yield* Ref.make({ archived: "", selection: "" })
      const interactiveConnection = {} as ServerInteractiveConnection.Connection
      const archiveFailure = ProductOperation.OperationUnavailable.make({
        operation: "ArchiveAndNewThread",
        message: "archive failed",
      })
      const initialSession = {
        selectThread: () => Effect.void,
        archiveAndNewThread: Effect.fail(archiveFailure),
      } as unknown as InteractiveSession
      const reconnectedSession = {
        selectThread: (threadId: string) =>
          Deferred.succeed(reattachedSelection, `thread:${threadId}`).pipe(Effect.asVoid),
        reopenThread: Deferred.succeed(reattachedSelection, "latest").pipe(Effect.asVoid),
      } as unknown as InteractiveSession
      const connection = (
        connectionId: string,
        session: InteractiveSession,
        run: Effect.Effect<never, ProductOperation.OperationUnavailable | ServerService.ServerServiceError>,
      ): ServerService.Connection => ({
        role: "attached",
        endpoint: "test",
        connectionId,
        ping: Effect.void,
        run: (input, options) =>
          input._tag !== "Interactive" || options?.interactive === undefined
            ? Effect.die("interactive handler required")
            : Effect.raceFirst(options.interactive(input, session, interactiveConnection), run),
        closed: Effect.never,
        close: Effect.void,
      })
      const disconnected = ProductOperation.OperationUnavailable.make({
        operation: "ServerConnection",
        message: "connection closed",
      })
      const first = connection(
        "first",
        initialSession,
        Deferred.await(disconnect).pipe(Effect.andThen(Effect.fail(disconnected))),
      )
      const second = connection("second", reconnectedSession, Effect.never)
      const supervise = makeInteractiveSupervisor({
        initial: first,
        acquireReady: () => Effect.succeed(second),
        logicalClosed,
      })

      yield* supervise({ _tag: "Interactive", prompt: [], ephemeral: false }, (_input, session) =>
        Effect.gen(function* () {
          yield* session.selectThread("selected-thread")
          const archived = yield* Effect.result(session.archiveAndNewThread)
          yield* Deferred.succeed(disconnect, undefined)
          const selection = yield* Deferred.await(reattachedSelection)
          yield* Ref.set(observed, {
            archived: archived._tag === "Failure" ? archived.failure.message : "success",
            selection,
          })
        }),
      )

      expect(yield* Ref.get(observed)).toEqual({
        archived: archiveFailure.message,
        selection: "thread:selected-thread",
      })
    }),
  )
})
