import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as UsageRepository from "@rika/product-store/sqlite-usage-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { storeProjection, baseBackend, thread, interactiveLayer } from "./operation-interactive-extensions-support"
import { terminalTransitionScenario } from "./operation-interactive-extension-terminal-support"

describe("interactive session extensions", () => {
  it.effect("adopts completed to failed and cancelled transitions through authoritative refold", () =>
    Effect.forEach(["failed", "cancelled"] as const, (status) => terminalTransitionScenario(status, false), {
      discard: true,
    }),
  )

  it.effect("adopts completed to failed and cancelled transitions from a multi-page authoritative history", () =>
    Effect.forEach(["failed", "cancelled"] as const, (status) => terminalTransitionScenario(status, true), {
      discard: true,
    }),
  )

  it.effect("previews a non-terminal thread from persisted units", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const previewed = thread("previewed")
        const running: Turn.Turn = {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("preview-turn"),
          threadId: previewed.id,
          prompt: "preview prompt",
          stopIntent: "none",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          status: "running",
          lastCursor: "stored-cursor",
          createdAt: 1,
          updatedAt: 1,
        }
        const repository = yield* ThreadRepository.makeMemory([previewed])
        const turns = yield* TurnRepository.makeMemory([running])
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        yield* storeProjection(
          transcripts,
          running,
          TranscriptProjection.Projection.project(running.id, running.prompt, [
            {
              cursor: "stored-cursor",
              sequence: 1,
              type: "model.output.completed",
              createdAt: 1,
              text: "persisted preview answer",
            },
          ]),
          { consumed: { [String(running.id)]: { cursor: "stored-cursor", sequence: 1 } }, projectionVersion: 2 },
        )
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) =>
            Effect.succeed({
              turnId: String(executionId),
              status: "running" as const,
              waits: [],
              pendingTools: [],
              children: [],
            }),
          replay: (executionId) =>
            Effect.succeed({
              turnId: String(executionId),
              status: "running" as const,
              events: [
                {
                  executionId: String(executionId),
                  cursor: "backend-cursor",
                  sequence: 2,
                  type: "model.output.completed",
                  createdAt: 2,
                  text: "backend rebuilt answer",
                },
              ],
            }),
          follow: (executionId) =>
            Effect.succeed({ turnId: String(executionId), status: "running" as const, events: [] }),
        })
        const registration = yield* Deferred.make<InteractiveSession>()
        const context = yield* Layer.build(
          interactiveLayer(
            repository,
            turns,
            backend,
            registration,
            Effect.die("unused"),
            Effect.die("unused"),
            transcripts,
          ),
        )
        const operation = Context.get(context, Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))

        yield* session.previewThread(String(previewed.id))
        for (
          let attempt = 0;
          attempt < 400 && !events.some((event) => event._tag === "ThreadPreviewLoaded");
          attempt += 1
        )
          yield* Effect.yieldNow

        const preview = events.find((event) => event._tag === "ThreadPreviewLoaded")
        if (preview?._tag !== "ThreadPreviewLoaded") return yield* Effect.die("missing thread preview")
        expect(preview.threadId).toBe(String(previewed.id))
        expect(preview.turns.map((value) => value.prompt)).toEqual(["preview prompt"])
        const previewUnits = yield* Schema.decodeUnknownEffect(Schema.Array(TranscriptUnit.Unit))(
          preview.turns.flatMap((value) => value.units),
        )
        expect(
          previewUnits.some(
            (unit) => unit.content._tag === "Entry" && unit.content.text === "persisted preview answer",
          ),
        ).toBe(true)
        expect(
          previewUnits.some((unit) => unit.content._tag === "Entry" && unit.content.text === "backend rebuilt answer"),
        ).toBe(false)

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("bounds an oversized stored Turn without failing the selection", () =>
    terminalTransitionScenario("failed", true, true),
  )

  it.effect("submits while persisted thread usage is still loading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("persisted-usage-read")
        const repository = yield* ThreadRepository.makeMemory([selected])
        const turns = yield* TurnRepository.makeMemory()
        const usageContext = yield* Layer.build(UsageRepository.memoryLayer)
        const memoryUsage = Context.get(usageContext, UsageRepository.Service)
        const readStarted = yield* Deferred.make<void>()
        const releaseRead = yield* Deferred.make<void>()
        const usage: UsageRepository.Interface = {
          ...memoryUsage,
          readThread: (threadId) =>
            Deferred.succeed(readStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRead)),
              Effect.andThen(memoryUsage.readThread(threadId)),
            ),
        }
        const submissionStarted = yield* Deferred.make<void>()
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: () => Effect.die("usage loading must not inspect Relay"),
          replay: () => Effect.die("usage loading must not replay Relay"),
          start: (input) =>
            Deferred.succeed(submissionStarted, undefined).pipe(Effect.andThen(baseBackend.start(input))),
        })
        const registration = yield* Deferred.make<InteractiveSession>()
        const context = yield* Layer.build(
          interactiveLayer(
            repository,
            turns,
            backend,
            registration,
            Effect.die("unused"),
            Effect.succeed(Turn.TurnId.make("submitted-turn")),
            undefined,
            usage,
          ),
        )
        const operation = Context.get(context, Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)

        yield* session.selectThread(selected.id, 1)
        yield* Deferred.await(readStarted)
        yield* session.submit("send now")
        yield* Deferred.await(submissionStarted)

        yield* Deferred.succeed(releaseRead, undefined)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )
})
