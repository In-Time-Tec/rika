import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ResolvedContext from "../src/context/context-resolution-service"
import type * as RootTurnOwner from "../src/thread/queue/root-turn-owner"
import { watchRootTurn } from "../src/operation/interactive/root-turn-watcher"

const thread: Thread.Thread = {
  id: Thread.ThreadId.make("thread"),
  workspace: "/workspace",
  title: "Thread",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 0,
  updatedAt: 0,
}

const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("turn"),
  threadId: thread.id,
  prompt: "work",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: {
    mode: "medium",
    providerId: "provider",
    modelId: "model",
    fastMode: false,
    behaviorModeDigest: "behavior",
    providerConfigDigest: "provider-config",
  },
  executionLink: { runId: "run", threadId: thread.id, turnId: "turn" },
  status: "running",
  createdAt: 0,
  updatedAt: 0,
}

it.effect("delivers completion only through the live projection callback", () =>
  Effect.gen(function* () {
    const state: ExecutionProjection.ProjectionState = {
      status: "completed",
      usage: ExecutionProjection.emptyUsageState(),
      steering: { steeringMessages: 0, followUpMessages: 0 },
    }
    const change: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      units: [],
      hasOlder: false,
      state,
    }
    const projectionEvents: Array<ExecutionProjection.Change> = []
    let statusUpdates = 0
    let settlements = 0
    const watched = watchRootTurn({
      turnId: turn.id,
      turns: { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      owner: {
        watchTurn: (_turnId, onChange) =>
          Effect.sync(() => {
            onChange?.(change)
            return { turnId: turn.id, status: "completed" as const, state, units: [] }
          }),
      } as RootTurnOwner.Interface,
      setTurnStatus: (_turnId, status, now) =>
        Effect.sync(() => {
          statusUpdates += 1
          return { ...turn, status, updatedAt: now } as Turn.AgentExecutionTurn
        }),
      settleThread: () =>
        Effect.sync(() => {
          settlements += 1
        }),
      threadForTurn: () => Effect.succeed(thread),
      dispatch: (event) => {
        if (event._tag === "ExecutionProjectionChanged") projectionEvents.push(event.change)
      },
      now: Effect.succeed(1),
    }).pipe(
      Effect.orDie,
      Effect.provideService(ResolvedContext.Service, ResolvedContext.Service.of({} as ResolvedContext.Interface)),
      Effect.provideService(ThreadRepository.Service, ThreadRepository.Service.of({} as ThreadRepository.Interface)),
      Effect.provideService(TurnRepository.Service, TurnRepository.Service.of({} as TurnRepository.Interface)),
      Effect.provideService(
        ThreadSummaryRepository.Service,
        ThreadSummaryRepository.Service.of({} as ThreadSummaryRepository.Interface),
      ),
      Effect.provideService(
        ExecutionExtensions.ExecutionExtensionService,
        ExecutionExtensions.ExecutionExtensionService.of({} as ExecutionExtensions.ExecutionExtensionInterface),
      ),
    )
    yield* watched
    expect(projectionEvents).toEqual([change])
    expect(statusUpdates).toBe(1)
    expect(settlements).toBe(1)
  }),
)
