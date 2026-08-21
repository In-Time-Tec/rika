import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import type { Projection } from "@rika/product/transcript-page"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import {
  HostedTurnWorkerStore,
  type ClaimRequest,
  type HostedTurnWorkerStoreService,
  type TurnClaim,
} from "@rika/product-store/postgres-turn-worker-store"
import { Context, Deferred, Effect, Exit, Layer, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { layer as projectionWorkerLayer } from "../src/hosted-projection-worker"
import { layer as turnWorkerLayer } from "../src/hosted-turn-worker"

const threadId = Thread.ThreadId.make("restart-thread")
const turnId = Turn.TurnId.make("restart-turn")
const input: ExecutionGateway.StartTurn = {
  threadId,
  turnId,
  workspaceId: "restart-workspace",
  prompt: "recover this run",
  executionRoute: ExecutionRoute.testExecutionRoute(),
}

it.effect("converges across API, Turn worker, runtime, projection, and terminal-persistence replacement", () =>
  Effect.gen(function* () {
    const claimed = yield* Deferred.make<void>()
    const runtimeStarted = yield* Deferred.make<void>()
    const runningCommitted = yield* Deferred.make<void>()
    const terminalPersistenceEntered = yield* Deferred.make<void>()
    const terminalPersisted = yield* Deferred.make<void>()
    const durable = {
      commands: new Map<string, string>(),
      turns: new Map<string, Turn.AgentExecutionTurn>(),
      claim: undefined as TurnClaim | undefined,
      prepared: false,
      link: undefined as ExecutionGateway.ExecutionLink | undefined,
      runs: new Map<string, ExecutionGateway.ExecutionLink>(),
      runtimeStartCalls: 0,
      projection: undefined as Projection | undefined,
      projectionCommits: new Map<number, number>(),
      terminalPersistenceAttempts: 0,
      operationReceipts: new Map([["unknown-operation", "unknown" as const]]),
      operationDispatches: 1,
    }
    const admit = (operationKey: string) =>
      Effect.sync(() => {
        const existing = durable.commands.get(operationKey)
        if (existing !== undefined) return existing
        durable.commands.set(operationKey, turnId)
        durable.turns.set(turnId, {
          _tag: "AgentExecution",
          id: turnId,
          threadId,
          prompt: input.prompt,
          executionRoute: input.executionRoute,
          status: "queued",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          createdAt: 0,
          updatedAt: 0,
        })
        return turnId
      })

    expect(yield* admit("restart-command")).toBe(turnId)
    const replacementAdmissionService = { admit }
    expect(yield* replacementAdmissionService.admit("restart-command")).toBe(turnId)
    expect(durable.turns.size).toBe(1)

    const claimFor = (request: ClaimRequest, prepared: boolean) => {
      if (durable.claim !== undefined && durable.claim.expiresAt > request.now) return undefined
      const turn = durable.turns.get(turnId)
      if (turn === undefined || (prepared ? !durable.prepared || durable.link !== undefined : turn.status !== "queued"))
        return undefined
      durable.claim = {
        workerId: request.workerId,
        claimToken: request.claimToken,
        expiresAt: request.now + request.leaseMillis,
        prepared,
        ownerId: "restart-owner",
        claimedAt: request.now,
        input,
      }
      return durable.claim
    }
    const store: HostedTurnWorkerStoreService = {
      claimNext: (request) =>
        Effect.sync(() => claimFor(request, false)).pipe(
          Effect.tap((value) => (value === undefined ? Effect.void : Deferred.succeed(claimed, undefined))),
        ),
      claimRecovery: (request) => Effect.sync(() => claimFor(request, true)),
      prepare: (claim) =>
        Effect.sync(() => {
          if (durable.claim?.claimToken !== claim.claimToken) return false
          durable.prepared = true
          durable.turns.set(turnId, { ...durable.turns.get(turnId)!, status: "running" })
          return true
        }),
      renew: (claim, now, leaseMillis) =>
        Effect.sync(() => {
          if (durable.claim?.claimToken !== claim.claimToken || durable.claim.expiresAt <= now) return false
          durable.claim = { ...durable.claim, expiresAt: now + leaseMillis }
          return true
        }),
      complete: (claim, link) =>
        Effect.sync(() => {
          if (durable.claim?.claimToken !== claim.claimToken) throw new Error("stale claim completed")
          durable.link = link
          durable.turns.set(turnId, { ...durable.turns.get(turnId)!, executionLink: link })
          durable.claim = undefined
        }),
      release: () =>
        Effect.sync(() => {
          durable.claim = undefined
        }),
    }
    const gatewayBase = Context.get(yield* Layer.build(ExecutionGateway.layerTest()), ExecutionGateway.Service)
    const buildTurnWorker = (workerId: string, gateway: ExecutionGateway.Interface, scope: Scope.Scope) =>
      Layer.buildWithScope(
        turnWorkerLayer({ workerId, leaseMillis: 30, pollIntervalMillis: 10 }).pipe(
          Layer.provide(Layer.succeed(HostedTurnWorkerStore, store)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          Layer.provide(BunCrypto.layer),
        ),
        scope,
      )

    const claimScope = yield* Scope.make()
    yield* buildTurnWorker("claim-worker-1", gatewayBase, claimScope)
    yield* Deferred.await(claimed)
    yield* Scope.close(claimScope, Exit.void)
    yield* TestClock.adjust(31)

    const crashingGateway = ExecutionGateway.Service.of({
      ...gatewayBase,
      startTurn: () =>
        Effect.sync(() => {
          durable.runtimeStartCalls += 1
          const link = durable.runs.get(turnId) ?? { runId: "restart-run", threadId, turnId }
          durable.runs.set(turnId, link)
          return link
        }).pipe(
          Effect.tap(() => Deferred.succeed(runtimeStarted, undefined)),
          Effect.andThen(Effect.never),
        ),
    })
    const runtimeScope = yield* Scope.make()
    yield* buildTurnWorker("claim-worker-2", crashingGateway, runtimeScope)
    yield* Deferred.await(runtimeStarted)
    yield* Scope.close(runtimeScope, Exit.void)
    expect(durable.link).toBeUndefined()
    yield* TestClock.adjust(31)

    const recoveryGateway = ExecutionGateway.Service.of({
      ...gatewayBase,
      startTurn: () =>
        Effect.sync(() => {
          durable.runtimeStartCalls += 1
          return durable.runs.get(turnId)!
        }),
    })
    const completionScope = yield* Scope.make()
    yield* buildTurnWorker("claim-worker-3", recoveryGateway, completionScope)
    yield* TestClock.adjust(1)
    expect(durable.link).toEqual({ runId: "restart-run", threadId, turnId })
    yield* Scope.close(completionScope, Exit.void)
    expect(durable.turns.size).toBe(1)
    expect(durable.runs.size).toBe(1)
    expect(durable.runtimeStartCalls).toBe(2)
    expect(durable.operationReceipts.get("unknown-operation")).toBe("unknown")
    expect(durable.operationDispatches).toBe(1)

    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 0,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "running", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "running",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionPatch",
      baseRevision: 0,
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "terminal", state: "{}" },
      upsert: [],
      remove: [],
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const turns = {
      get: () => Effect.succeed(durable.turns.get(turnId)),
      setStatus: (_id: Turn.TurnId, status: ExecutionProjection.Result["status"]) => {
        durable.terminalPersistenceAttempts += 1
        if (durable.terminalPersistenceAttempts === 1)
          return Deferred.succeed(terminalPersistenceEntered, undefined).pipe(Effect.andThen(Effect.never))
        return Effect.sync(() => {
          durable.turns.set(turnId, { ...durable.turns.get(turnId)!, status })
        }).pipe(
          Effect.tap(() => Deferred.succeed(terminalPersisted, undefined)),
          Effect.as(durable.turns.get(turnId)!),
        )
      },
    } as unknown as TurnRepository.Interface
    const transcripts = {
      listProjectionRecoveryCandidates: () => Effect.succeed([{ threadId, turnId }]),
      get: () => Effect.succeed(durable.projection),
      commitProjection: (_turn: Turn.AgentExecutionTurn, change: ExecutionProjection.Change) =>
        Effect.sync(() => {
          durable.projectionCommits.set(change.revision, (durable.projectionCommits.get(change.revision) ?? 0) + 1)
          durable.projection = {
            turn: durable.turns.get(turnId)!,
            units: change._tag === "ProjectionSnapshot" ? change.units : (durable.projection?.units ?? []),
            checkpointGeneration: (durable.projection?.checkpointGeneration ?? 0) + 1,
            revision: change.revision,
            state: change.state,
            ...(change.checkpoint === undefined ? {} : { projectorCheckpoint: change.checkpoint }),
            projectionVersion: ExecutionProjection.projectionVersion,
          }
          return "committed" as const
        }).pipe(
          Effect.tap(() => (change.revision === 0 ? Deferred.succeed(runningCommitted, undefined) : Effect.void)),
        ),
    } as unknown as TranscriptRepository.Interface
    const buildProjectionWorker = (gateway: ExecutionGateway.Interface, scope: Scope.Scope) =>
      Layer.buildWithScope(
        projectionWorkerLayer({ concurrency: 1, pollIntervalMillis: 10 }).pipe(
          Layer.provide(Layer.succeed(TurnRepository.Service, turns)),
          Layer.provide(Layer.succeed(TranscriptRepository.Service, transcripts)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
        ),
        scope,
      )
    const projectionScope = yield* Scope.make()
    yield* buildProjectionWorker(
      ExecutionGateway.Service.of({
        ...gatewayBase,
        watchTurn: () => Stream.concat(Stream.succeed(running), Stream.never),
      }),
      projectionScope,
    )
    yield* Deferred.await(runningCommitted)
    yield* Scope.close(projectionScope, Exit.void)

    const terminalScope = yield* Scope.make()
    yield* buildProjectionWorker(
      ExecutionGateway.Service.of({
        ...gatewayBase,
        watchTurn: () => Stream.succeed(completed),
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "terminal" }),
      }),
      terminalScope,
    )
    yield* Deferred.await(terminalPersistenceEntered)
    yield* Scope.close(terminalScope, Exit.void)

    const persistenceScope = yield* Scope.make()
    yield* buildProjectionWorker(
      ExecutionGateway.Service.of({
        ...gatewayBase,
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "terminal" }),
      }),
      persistenceScope,
    )
    yield* Deferred.await(terminalPersisted)
    yield* Scope.close(persistenceScope, Exit.void)
    expect(durable.projectionCommits).toEqual(
      new Map([
        [0, 1],
        [1, 1],
      ]),
    )
    expect(durable.projection).toMatchObject({
      revision: 1,
      state: { status: "completed" },
      projectorCheckpoint: { cursor: "terminal" },
    })
    expect(durable.turns.get(turnId)).toMatchObject({ status: "completed", executionLink: durable.link })
  }),
)
