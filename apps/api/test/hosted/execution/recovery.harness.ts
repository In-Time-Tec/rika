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
import * as TranscriptStore from "@rika/product/transcript-repository"
import {
  HostedTurnWorkerStore,
  type ClaimRequest,
  type HostedTurnWorkerStoreService,
  type TurnClaim,
} from "@rika/product-store/turn-worker-store"
import { Clock, Context, Deferred, Effect, Exit, Layer, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { layer as executionReconcilerLayer } from "../../../src/hosted/execution/reconciler"
import { layer as projectionWorkerLayer } from "../../../src/hosted/execution/projection-worker"
import { HostedPreviewBus } from "../../../src/hosted/thread/previews"
import { layer as turnWorkerLayer } from "../../../src/hosted/thread/turn-worker"

const threadId = Thread.ThreadId.make("restart-thread")
const turnId = Turn.TurnId.make("restart-turn")
const input: ExecutionGateway.StartTurn = {
  threadId,
  turnId,
  workspaceId: "restart-workspace",
  prompt: "recover this run",
  executionRoute: ExecutionRoute.testExecutionRoute(),
}

interface DurableRecoveryState {
  readonly commands: Map<string, string>
  readonly turns: Map<string, Turn.AgentExecutionTurn>
  claim: TurnClaim | undefined
  prepared: boolean
  preparedExecution: ExecutionGateway.PreparedTurn | undefined
  link: ExecutionGateway.ExecutionLink | undefined
  activationRequested: boolean
  readonly runs: Map<string, ExecutionGateway.ExecutionLink>
  runtimeStartCalls: number
  projection: Projection | undefined
  readonly projectionCommits: Map<number, number>
  terminalProjectionAttempts: number
  terminalPersistenceAttempts: number
  readonly operationReceipts: Map<string, "unknown">
  operationDispatches: number
}

it.effect("converges across API, Turn worker, runtime, projection, and terminal-persistence replacement", () =>
  Effect.gen(function* () {
    const claimed = yield* Deferred.make<void>()
    const runtimeStarted = yield* Deferred.make<void>()
    const runningCommitted = yield* Deferred.make<void>()
    const terminalPersistenceEntered = yield* Deferred.make<void>()
    const terminalPersisted = yield* Deferred.make<void>()
    const terminalProjectionFailed = yield* Deferred.make<void>()
    const terminalProjected = yield* Deferred.make<void>()
    const durable: DurableRecoveryState = {
      commands: new Map<string, string>(),
      turns: new Map<string, Turn.AgentExecutionTurn>(),
      claim: undefined,
      prepared: false,
      preparedExecution: undefined,
      link: undefined,
      activationRequested: false,
      runs: new Map<string, ExecutionGateway.ExecutionLink>(),
      runtimeStartCalls: 0,
      projection: undefined,
      projectionCommits: new Map<number, number>(),
      terminalProjectionAttempts: 0,
      terminalPersistenceAttempts: 0,
      operationReceipts: new Map([["unknown-operation", "unknown"]]),
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

    const claimFor = (request: ClaimRequest, prepared: boolean, now: number) => {
      if (durable.claim !== undefined && durable.claim.expiresAt > now) return undefined
      const turn = durable.turns.get(turnId)
      if (turn === undefined || (prepared ? !durable.prepared || durable.link !== undefined : turn.status !== "queued"))
        return undefined
      const claimBase = {
        workerId: request.workerId,
        claimToken: request.claimToken,
        expiresAt: now + request.leaseMillis,
        activationRequested: durable.activationRequested,
        ownerId: "restart-owner",
        claimedAt: now,
        input,
      }
      const claim: TurnClaim = (() => {
        if (durable.preparedExecution === undefined)
          return durable.link === undefined ? claimBase : { ...claimBase, admissionLink: durable.link }
        if (durable.link === undefined) return { ...claimBase, preparedExecution: durable.preparedExecution }
        return { ...claimBase, preparedExecution: durable.preparedExecution, admissionLink: durable.link }
      })()
      durable.claim = claim
      return claim
    }
    const store: HostedTurnWorkerStoreService = {
      claimNext: (request) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => claimFor(request, false, now)),
          Effect.tap((value) => (value === undefined ? Effect.void : Deferred.succeed(claimed, undefined))),
        ),
      claimRecovery: (request) => Clock.currentTimeMillis.pipe(Effect.map((now) => claimFor(request, true, now))),
      renew: (claim, leaseMillis) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            if (durable.claim?.claimToken !== claim.claimToken || durable.claim.expiresAt <= now) return false
            durable.claim = {
              ...durable.claim,
              expiresAt: now + leaseMillis,
            }
            return true
          }),
        ),
      prepare: (claim, preparedExecution) =>
        Effect.sync(() => {
          if (durable.claim?.claimToken !== claim.claimToken) return false
          durable.prepared = true
          durable.preparedExecution = preparedExecution
          durable.turns.set(turnId, {
            ...durable.turns.get(turnId)!,
            status: "accepted",
          })
          return true
        }),
      completeAdmission: (claim, link) =>
        Effect.sync(() => {
          if (durable.claim?.claimToken !== claim.claimToken) throw new Error("stale claim completed")
          const turn = durable.turns.get(turnId)
          if (turn === undefined) throw new Error("completed Turn is unavailable")
          durable.link = link
        }),
      requestActivation: (claim) =>
        Effect.sync(() => {
          if (durable.claim?.claimToken !== claim.claimToken) throw new Error("stale claim activated")
          durable.activationRequested = true
          durable.turns.set(turnId, {
            ...durable.turns.get(turnId)!,
            executionLink: durable.link!,
          })
          durable.turns.set(turnId, {
            ...durable.turns.get(turnId)!,
            status: "running",
          })
          return true
        }),
      completeActivation: (claim) =>
        Effect.sync(() => {
          if (durable.claim?.claimToken !== claim.claimToken) throw new Error("stale claim completed")
          durable.claim = undefined
        }),
      release: () =>
        Effect.sync(() => {
          durable.claim = undefined
        }),
    }
    const gatewayBase = ExecutionGateway.makeTest()
    const buildTurnWorker = (workerId: string, gateway: ExecutionGateway.Interface, scope: Scope.Scope) =>
      Layer.buildWithScope(
        turnWorkerLayer({
          workerId,
          leaseMillis: 30,
          pollIntervalMillis: 10,
        }).pipe(
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
      admitTurn: (prepared) =>
        Effect.sync(() => {
          durable.runtimeStartCalls += 1
          const link = durable.runs.get(turnId) ?? {
            runId: prepared.runId,
            threadId,
            turnId,
          }
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
      admitTurn: () =>
        Effect.sync(() => {
          durable.runtimeStartCalls += 1
          const link = durable.runs.get(turnId)
          if (link === undefined) throw new Error("recoverable execution link is unavailable")
          return link
        }),
    })
    const completionScope = yield* Scope.make()
    yield* buildTurnWorker("claim-worker-3", recoveryGateway, completionScope)
    yield* TestClock.adjust(1)
    expect(durable.link).toEqual({ runId: turnId, threadId, turnId })
    yield* Scope.close(completionScope, Exit.void)
    expect(durable.turns.size).toBe(1)
    expect(durable.runs.size).toBe(1)
    expect(durable.runtimeStartCalls).toBe(2)
    expect(durable.operationReceipts.get("unknown-operation")).toBe("unknown")
    expect(durable.operationDispatches).toBe(1)

    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 0,
      checkpoint: {
        version: ExecutionProjection.projectionVersion,
        cursor: "running",
        state: "{}",
      },
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
      checkpoint: {
        version: ExecutionProjection.projectionVersion,
        cursor: "terminal",
        state: "{}",
      },
      upsert: [],
      remove: [],
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const turns = Layer.mock(TurnRepository.Service, {
      get: () => Effect.succeed(durable.turns.get(turnId)),
      listNonterminal: Effect.sync(() => {
        const current = durable.turns.get(turnId)
        return current === undefined || current.status === "completed" ? [] : [current]
      }),
      listSteeringAdmissions: Effect.succeed([]),
      setStatus: (_id: Turn.TurnId, status: import("@rika/product/execution-status").Status) => {
        durable.terminalPersistenceAttempts += 1
        if (durable.terminalPersistenceAttempts === 1)
          return Deferred.succeed(terminalPersistenceEntered, undefined).pipe(Effect.andThen(Effect.never))
        return Effect.sync(() => {
          const turn = durable.turns.get(turnId)
          if (turn === undefined) throw new Error("persisted Turn is unavailable")
          durable.turns.set(turnId, { ...turn, status })
          return { ...turn, status }
        }).pipe(Effect.tap(() => Deferred.succeed(terminalPersisted, undefined)))
      },
    })
    const transcriptRepository = Context.get(
      yield* Layer.build(TranscriptStore.memoryLayer()),
      TranscriptRepository.Service,
    )
    const transcripts = TranscriptRepository.Service.of({
      ...transcriptRepository,
      listProjectionRecoveryCandidates: () => Effect.succeed([{ threadId, turnId }]),
      get: () => Effect.succeed(durable.projection),
      commitProjection: (turn: Turn.AgentExecutionTurn, change: ExecutionProjection.Change) => {
        if (change.revision === 1) {
          durable.terminalProjectionAttempts += 1
          if (durable.terminalProjectionAttempts === 1)
            return Deferred.succeed(terminalProjectionFailed, undefined).pipe(
              Effect.andThen(Effect.die("terminal projection commit failed")),
            )
        }
        return Effect.sync(() => {
          durable.projectionCommits.set(change.revision, (durable.projectionCommits.get(change.revision) ?? 0) + 1)
          const projection = {
            turn,
            units: change._tag === "ProjectionSnapshot" ? change.units : (durable.projection?.units ?? []),
            checkpointGeneration: (durable.projection?.checkpointGeneration ?? 0) + 1,
            revision: change.revision,
            state: change.state,
            projectionVersion: ExecutionProjection.projectionVersion,
          }
          durable.projection =
            change.checkpoint === undefined ? projection : { ...projection, projectorCheckpoint: change.checkpoint }
          const result: TranscriptRepository.WriteResult = "committed"
          return result
        }).pipe(
          Effect.tap(() => (change.revision === 0 ? Deferred.succeed(runningCommitted, undefined) : Effect.void)),
          Effect.tap(() => (change.revision === 1 ? Deferred.succeed(terminalProjected, undefined) : Effect.void)),
        )
      },
    })
    const buildWorkers = (gateway: ExecutionGateway.Interface, scope: Scope.Scope) =>
      Layer.buildWithScope(
        Layer.merge(
          projectionWorkerLayer({ concurrency: 1, pollIntervalMillis: 10 }).pipe(
            Layer.provide(HostedPreviewBus.memoryLayer),
          ),
          executionReconcilerLayer({ pollIntervalMillis: 10 }),
        ).pipe(
          Layer.provide(turns),
          Layer.provide(Layer.succeed(TranscriptRepository.Service, transcripts)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
        ),
        scope,
      )
    const projectionScope = yield* Scope.make()
    yield* buildWorkers(
      ExecutionGateway.Service.of({
        ...gatewayBase,
        watchTurn: () => Stream.concat(Stream.succeed(running), Stream.never),
        inspectTurn: () => Effect.succeed({ status: "running", cursor: "running" }),
      }),
      projectionScope,
    )
    yield* Deferred.await(runningCommitted)
    yield* Scope.close(projectionScope, Exit.void)

    const terminalScope = yield* Scope.make()
    yield* buildWorkers(
      ExecutionGateway.Service.of({
        ...gatewayBase,
        watchTurn: () => Stream.succeed(completed),
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "terminal" }),
      }),
      terminalScope,
    )
    yield* Deferred.await(terminalPersistenceEntered)
    yield* Deferred.await(terminalProjectionFailed)
    yield* Scope.close(terminalScope, Exit.void)

    const persistenceScope = yield* Scope.make()
    yield* buildWorkers(
      ExecutionGateway.Service.of({
        ...gatewayBase,
        watchTurn: () => Stream.succeed(completed),
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "terminal" }),
      }),
      persistenceScope,
    )
    yield* Deferred.await(terminalPersisted)
    yield* Deferred.await(terminalProjected)
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
    expect(durable.turns.get(turnId)).toMatchObject({
      status: "completed",
      executionLink: durable.link,
    })
  }),
)
