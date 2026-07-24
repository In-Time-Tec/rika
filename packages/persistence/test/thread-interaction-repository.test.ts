import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import * as Database from "../src/product-database"
import * as Repository from "../src/thread-interaction-repository"
import * as ThreadRepository from "../src/thread-repository"
import * as Thread from "../src/thread-schema"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "../src/turn-schema"

const sourceThreadId = Thread.ThreadId.make("source")
const sourceTurnId = Turn.TurnId.make("source-turn")
const route = Turn.testExecutionRoute()
const sourceThread: Thread.Thread = {
  id: sourceThreadId,
  workspace: "/workspace",
  title: "Source",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const sourceTurn: Turn.Turn = {
  id: sourceTurnId,
  threadId: sourceThreadId,
  prompt: "source",
  status: "running",
  executionRoute: route,
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const sourceQueuedTurn: Turn.Turn = {
  ...sourceTurn,
  id: Turn.TurnId.make("source-queued"),
  prompt: "already queued",
  status: "queued",
  createdAt: 2,
  updatedAt: 2,
}
const otherWorkspaceThread: Thread.Thread = {
  ...sourceThread,
  id: Thread.ThreadId.make("other-workspace"),
  workspace: "/other",
  title: "Other workspace",
}
const limits = { maximumDepth: 3, maximumAdmissions: 8, maximumWorkspaceActive: 8, queueCapacity: 2 }
const invocation = (digest: string, input = digest, now = 2) => ({
  invocationDigest: digest,
  schemaInputDigest: input,
  sourceThreadId,
  sourceRootTurnId: sourceTurnId,
  now,
})

const provideBun = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))

const exercise = (repository: Repository.Interface) =>
  Effect.gen(function* () {
    const targetThreadId = Thread.ThreadId.make("target")
    const targetTurnId = Turn.TurnId.make("target-turn")
    const created = yield* repository
      .createThread({
        ...invocation("create"),
        ...limits,
        threadId: targetThreadId,
        turnId: targetTurnId,
        title: "Target",
        prompt: "work",
        executionRoute: route,
        resultDelivery: "reply",
        threadCreationDepth: 1,
      })
      .pipe(
        Effect.mapError((cause) =>
          Repository.RepositoryError.make({ message: `create: ${cause.message ?? String(cause)}` }),
        ),
      )
    const duplicate = yield* repository.createThread({
      ...invocation("create", "create", 99),
      ...limits,
      threadId: Thread.ThreadId.make("ignored"),
      turnId: Turn.TurnId.make("ignored"),
      title: "Ignored",
      prompt: "ignored",
      executionRoute: route,
      resultDelivery: "reply",
      threadCreationDepth: 1,
    })
    const conflict = yield* Effect.result(
      repository.createThread({
        ...invocation("create", "changed"),
        ...limits,
        threadId: targetThreadId,
        turnId: targetTurnId,
        title: "Target",
        prompt: "changed",
        executionRoute: route,
        resultDelivery: "reply",
        threadCreationDepth: 1,
      }),
    )
    const crossWorkspace = yield* Effect.result(
      repository.appendMessage({
        ...invocation("cross-workspace"),
        ...limits,
        targetThreadId: otherWorkspaceThread.id,
        turnId: Turn.TurnId.make("cross-workspace"),
        prompt: "not allowed",
        executionRoute: route,
        resultDelivery: "manual",
        threadCreationDepth: 1,
      }),
    )
    const queued = yield* repository
      .appendMessage({
        ...invocation("message", "message", 3),
        ...limits,
        targetThreadId,
        turnId: Turn.TurnId.make("queued"),
        prompt: "next",
        executionRoute: route,
        resultDelivery: "manual",
        threadCreationDepth: 1,
      })
      .pipe(
        Effect.mapError((cause) =>
          Repository.RepositoryError.make({ message: `message: ${cause.message ?? String(cause)}` }),
        ),
      )
    const firstUndeliveredPage = yield* repository.listUndeliveredResults(1)
    const secondUndeliveredPage = yield* repository.listUndeliveredResults(
      1,
      firstUndeliveredPage[0] === undefined ? undefined : { targetTurnId: firstUndeliveredPage[0].targetTurnId },
    )
    const stopped = yield* repository
      .bindStop({ ...invocation("stop", "stop", 4), targetThreadId })
      .pipe(
        Effect.mapError((cause) =>
          Repository.RepositoryError.make({ message: `stop: ${cause.message ?? String(cause)}` }),
        ),
      )
    const stoppedAgain = yield* repository.bindStop({ ...invocation("stop", "stop", 99), targetThreadId })
    const ready = yield* repository
      .markResultReady({
        targetTurnId,
        readiness: { _tag: "TerminalReady", cursor: "cursor", sequence: 4, output: "done" },
        now: 5,
      })
      .pipe(Effect.mapError((cause) => Repository.RepositoryError.make({ message: `ready: ${cause.message}` })))
    const queueFull = yield* Effect.result(
      repository.deliverResult({
        targetTurnId,
        deliveredTurnId: Turn.TurnId.make("reply"),
        prompt: "done",
        queueCapacity: 1,
        now: 6,
      }),
    )
    const readyAfterQueueFull = yield* repository.getResultRoute(targetTurnId)
    const [delivered, concurrentDelivery] = yield* Effect.all(
      [
        repository.deliverResult({
          targetTurnId,
          deliveredTurnId: Turn.TurnId.make("reply"),
          prompt: "done",
          queueCapacity: 2,
          now: 6,
        }),
        repository.deliverResult({
          targetTurnId,
          deliveredTurnId: Turn.TurnId.make("reply"),
          prompt: "done",
          queueCapacity: 2,
          now: 6,
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) =>
        Repository.RepositoryError.make({ message: `deliver: ${cause.message ?? String(cause)}` }),
      ),
    )
    const deliveredAgain = yield* repository.deliverResult({
      targetTurnId,
      deliveredTurnId: Turn.TurnId.make("other"),
      prompt: "other",
      queueCapacity: 2,
      now: 7,
    })
    const manualReady = yield* repository.markResultReady({
      targetTurnId: Turn.TurnId.make("queued"),
      readiness: { _tag: "CancelledBeforeStartReady" },
      now: 8,
    })
    return {
      created,
      duplicate,
      conflict: conflict._tag,
      crossWorkspace: crossWorkspace._tag,
      queued,
      undeliveredPages: [...firstUndeliveredPage, ...secondUndeliveredPage].map((item) => item.targetTurnId),
      stopped,
      stoppedAgain,
      ready,
      queueFull: queueFull._tag,
      readyAfterQueueFull,
      delivered,
      concurrentDelivery,
      deliveredAgain,
      manualReady,
      readiness: yield* repository.getReadiness(targetTurnId),
      undelivered: yield* repository.listUndeliveredResults(),
      sourceRelationships: yield* repository.listRelationships(sourceThreadId, 1),
      targetRelationships: yield* repository.listRelationships(targetThreadId, 2),
      messages: yield* repository.getMessages(sourceThreadId),
    }
  })

describe("thread interaction repository", () => {
  it.effect("keeps atomic admission, control, readiness, and delivery equal in memory and SQLite", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memory = yield* Repository.makeMemory({
          threads: [sourceThread, otherWorkspaceThread],
          turns: [sourceTurn, sourceQueuedTurn],
        })
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-interaction-" })
        const database = Database.layer(`${directory}/rika.db`)
        const context = yield* Layer.build(
          Layer.mergeAll(
            database,
            Repository.layer.pipe(Layer.provide(database)),
            ThreadRepository.layer.pipe(Layer.provide(database)),
            TurnRepository.layer.pipe(Layer.provide(database)),
          ),
        )
        const threads = yield* ThreadRepository.Service.pipe(Effect.provide(context))
        const turns = yield* TurnRepository.Service.pipe(Effect.provide(context))
        yield* threads.create({
          id: sourceThread.id,
          workspace: sourceThread.workspace,
          title: sourceThread.title,
          lineage: sourceThread.lineage,
          now: 1,
        })
        yield* threads.create({
          id: otherWorkspaceThread.id,
          workspace: otherWorkspaceThread.workspace,
          title: otherWorkspaceThread.title,
          lineage: otherWorkspaceThread.lineage,
          now: 1,
        })
        yield* turns.copy(sourceTurn, 2)
        yield* turns.copy(sourceQueuedTurn, 2)
        const sqlite = yield* Repository.Service.pipe(Effect.provide(context))
        const memoryResult = yield* exercise(memory)
        const sqliteResult = yield* exercise(sqlite)
        expect(sqliteResult).toEqual(memoryResult)
        expect(sqliteResult).toMatchObject({
          created: { status: "accepted" },
          duplicate: { threadId: "target", turnId: "target-turn" },
          conflict: "Failure",
          crossWorkspace: "Failure",
          queued: { status: "queued", queueRevision: 1 },
          undeliveredPages: ["queued", "target-turn"],
          stopped: { targetTurnId: "target-turn", stoppedTurnIds: ["queued"], queueRevision: 2 },
          queueFull: "Failure",
          readyAfterQueueFull: { targetTurnId: "target-turn", delivery: "ready" },
          delivered: { delivery: "delivered", deliveredTurnId: "reply" },
          concurrentDelivery: { delivery: "delivered", deliveredTurnId: "reply" },
          deliveredAgain: { delivery: "delivered", deliveredTurnId: "reply" },
          manualReady: { targetTurnId: "queued", kind: "manual", delivery: "ready" },
          readiness: { _tag: "TerminalReady", cursor: "cursor", sequence: 4, output: "done" },
          undelivered: [],
          sourceRelationships: [{ kind: "reply", sourceThreadId: "target", targetThreadId: "source" }],
          targetRelationships: [
            { kind: "reply", sourceThreadId: "target", targetThreadId: "source" },
            { kind: "message", sourceThreadId: "source", targetThreadId: "target" },
          ],
        })
        expect(sqliteResult.messages.at(-1)).toMatchObject({
          id: "reply",
          status: "queued",
          author: { _tag: "Agent", sourceThreadId: "target", sourceRootTurnId: "target-turn" },
        })
      }).pipe(provideBun),
    ),
  )
})
