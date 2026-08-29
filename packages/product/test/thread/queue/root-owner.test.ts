import * as ExecutionProjection from "@rika/product/execution-projection"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import type { Projection } from "@rika/product/transcript-page"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import type * as TurnRepositorySteering from "@rika/product/turn-repository-steering"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { unitOrder } from "@rika/transcript/transcript-unit-order"

const encodeStartTurn = Schema.encodeSync(Schema.fromJsonString(ExecutionGateway.StartTurn))
import { make } from "../../../src/thread/queue/root-owner"
import { settleInteractiveSubmission } from "../../../src/operation/interactive/turn/admission"

const link = { runId: "root-run", threadId: "thread", turnId: "turn" }

const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("turn"),
  threadId: Thread.ThreadId.make("thread"),
  prompt: "work",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  executionLink: link,
  status: "running",
  createdAt: 0,
  updatedAt: 0,
}

it.effect("coalesces an observer request that arrives before the current observer releases", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({}),
    )
    expect(yield* owner.claim(turn.id)).toBe(true)
    expect(yield* owner.claim(turn.id)).toBe(false)
    expect(yield* owner.release(turn.threadId, turn.id)).toBe(true)
    expect(yield* owner.claim(turn.id)).toBe(true)
    expect(yield* owner.release(turn.threadId, turn.id)).toBe(false)
  }),
)

it.effect("lets another Thread start while one Thread is blocked", () =>
  Effect.gen(function* () {
    const xEntered = yield* Deferred.make<void>()
    const releaseX = yield* Deferred.make<void>()
    const yEntered = yield* Deferred.make<void>()
    const repository = TurnRepository.Service.of({
      prepareExecutionAdmission: (input) => Effect.succeed(input),
      attachExecutionLink: (turnId: Turn.TurnId, executionLink: ExecutionGateway.ExecutionLink) =>
        Effect.succeed({
          ...turn,
          id: turnId,
          threadId: Thread.ThreadId.make(executionLink.threadId),
          executionLink,
        }),
    })
    const owner = yield* make(
      repository,
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({
        startTurn: (input) =>
          (input.threadId === "thread-x"
            ? Deferred.succeed(xEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseX)))
            : Deferred.succeed(yEntered, undefined)
          ).pipe(Effect.as({ runId: `run-${input.turnId}`, threadId: input.threadId, turnId: input.turnId })),
      }),
    )
    const start = (threadId: string, turnId: string) =>
      owner.startTurn({
        threadId,
        turnId,
        workspaceId: "/workspace",
        prompt: "work",
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
      })
    const x = yield* Effect.forkChild(start("thread-x", "turn-x"))
    yield* Deferred.await(xEntered)
    const y = yield* Effect.forkChild(start("thread-y", "turn-y"))
    yield* Effect.yieldNow
    const yProgressedWhileXWasBlocked = yield* Deferred.isDone(yEntered)
    yield* Deferred.succeed(releaseX, undefined)
    yield* Fiber.join(x)
    yield* Fiber.join(y)
    expect(yProgressedWhileXWasBlocked).toBe(true)
  }),
)

it.effect("quiesces only the affected Thread fibers", () =>
  Effect.gen(function* () {
    const xEntered = yield* Deferred.make<void>()
    const yEntered = yield* Deferred.make<void>()
    const xInterrupted = yield* Deferred.make<void>()
    const yInterrupted = yield* Deferred.make<void>()
    const finishY = yield* Deferred.make<void>()
    const xTurn = { ...turn, id: Turn.TurnId.make("turn-x"), threadId: Thread.ThreadId.make("thread-x") }
    const yTurn = { ...turn, id: Turn.TurnId.make("turn-y"), threadId: Thread.ThreadId.make("thread-y") }
    const owner = yield* make(
      TurnRepository.Service.of({
        get: (turnId) => Effect.succeed(turnId === xTurn.id ? xTurn : yTurn),
      }),
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({}),
    )
    yield* owner.install({
      run: (turnId) =>
        (turnId === xTurn.id
          ? Deferred.succeed(xEntered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(xInterrupted, undefined).pipe(Effect.asVoid)),
            )
          : Deferred.succeed(yEntered, undefined).pipe(
              Effect.andThen(Deferred.await(finishY)),
              Effect.onInterrupt(() => Deferred.succeed(yInterrupted, undefined).pipe(Effect.asVoid)),
            )
        ).pipe(Effect.asVoid),
    })
    yield* owner.accepted(xTurn.threadId, xTurn.id)
    yield* owner.accepted(yTurn.threadId, yTurn.id)
    yield* Deferred.await(xEntered)
    yield* Deferred.await(yEntered)
    yield* owner.quiesceThread(xTurn.threadId)
    expect(yield* Deferred.isDone(xInterrupted)).toBe(true)
    expect(yield* Deferred.isDone(yInterrupted)).toBe(false)
    yield* Deferred.succeed(finishY, undefined)
  }),
)

it.effect("returns stored terminal state and units when checkpoint resume yields no new changes", () =>
  Effect.gen(function* () {
    const completed = { ...turn, status: "completed" as const }
    const units = [
      {
        key: "assistant:stored",
        turnId: turn.id,
        order: unitOrder("assistant:stored", 0),
        revision: 3,
        content: { _tag: "Entry" as const, role: "assistant" as const, text: "stored answer" },
      },
    ]
    const projection = {
      turn: completed,
      units,
      checkpointGeneration: 2,
      revision: 3,
      state: {
        status: "completed" as const,
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
      projectorCheckpoint: { version: ExecutionProjection.projectionVersion, cursor: "stored-cursor", state: "{}" },
      projectionVersion: 1,
    }
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(completed) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(projection),
        commitProjection: () => Effect.succeed("committed" as const),
      }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "stored-cursor" }),
      }),
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result).toMatchObject({
      status: "completed",
      state: { status: "completed" },
      units: [{ content: { text: "stored answer" } }],
      checkpoint: { cursor: "stored-cursor" },
    })
    expect(Object.hasOwn(result, "changes")).toBe(false)
  }),
)

it.effect("passes the included pricing class to the backend for an OpenAI account route", () =>
  Effect.gen(function* () {
    const route = ExecutionRouteSnapshot.testExecutionRoute()
    const accountTurn: Turn.AgentExecutionTurn = {
      ...turn,
      executionRoute: {
        ...route,
        main: {
          ...route.main,
          candidates: [
            {
              ...route.main.candidates[0]!,
              providerConnection: {
                provider: "openai",
                protocol: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                authentication: "account",
                credentialIdentity: "fingerprint",
              },
            },
          ],
        },
      },
    }
    const completed = { ...accountTurn, status: "completed" as const }
    const projection = {
      turn: completed,
      units: [],
      checkpointGeneration: 1,
      revision: 1,
      state: {
        status: "completed" as const,
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
      projectorCheckpoint: { version: ExecutionProjection.projectionVersion, cursor: "account", state: "{}" },
      projectionVersion: ExecutionProjection.projectionVersion,
    }
    let receivedPricing: string | undefined
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(completed) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(projection),
        commitProjection: () => Effect.succeed("committed" as const),
      }),
      ExecutionGateway.Service.of({
        watchTurn: (_link, input) => {
          receivedPricing = input?.pricing
          return Stream.empty
        },
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "account" }),
      }),
    )
    yield* owner.watchTurn(accountTurn.id)
    expect(receivedPricing).toBe("included")
  }),
)

it.effect("commits and delivers each live change once without retaining or redelivering completion", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
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
      baseRevision: 1,
      revision: 2,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "completed", state: "{}" },
      upsert: [],
      remove: [],
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    let stored: Projection | undefined
    const commits: Array<ExecutionProjection.Change> = []
    const trace: Array<string> = []
    let watches = 0
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(stored),
        commitProjection: (_turn, change) =>
          Effect.sync(() => {
            commits.push(change)
            trace.push(`commit:${change.revision}`)
            stored = {
              turn,
              units: [],
              checkpointGeneration: commits.length,
              revision: change.revision,
              state: change.state,
              projectorCheckpoint: change.checkpoint,
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      }),
      ExecutionGateway.Service.of({
        watchTurn: () => {
          watches += 1
          return watches === 1 ? Stream.fromIterable([running, completed]) : Stream.empty
        },
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "completed" }),
      }),
    )
    const delivered: Array<ExecutionProjection.Change> = []
    const first = yield* owner.watchTurn(turn.id, (change) => {
      delivered.push(change)
      trace.push(`callback:${change.revision}`)
    })
    expect(commits).toEqual([running, completed])
    expect(delivered).toEqual([running, completed])
    expect(trace).toEqual(["commit:1", "callback:1", "commit:2", "callback:2"])
    expect(first).toMatchObject({
      status: "completed",
      state: { status: "completed" },
      checkpoint: { cursor: "completed" },
    })
    expect(Object.hasOwn(first, "changes")).toBe(false)

    const completionDeliveries: Array<ExecutionProjection.Change> = []
    const resumed = yield* owner.watchTurn(turn.id, (change) => completionDeliveries.push(change))
    expect(completionDeliveries).toEqual([])
    expect(commits).toHaveLength(2)
    expect(resumed.status).toBe("completed")
    expect(Object.hasOwn(resumed, "changes")).toBe(false)
  }),
)

it.effect("propagates a consumer callback defect instead of treating it as a reconnect", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "running", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "running",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    let watches = 0
    let commits = 0
    let inspections = 0
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.void,
        commitProjection: () => Effect.sync(() => ((commits += 1), "committed" as const)),
      }),
      ExecutionGateway.Service.of({
        watchTurn: () => {
          watches += 1
          return Stream.succeed(running)
        },
        inspectTurn: () =>
          Effect.sync(() => {
            inspections += 1
            return { status: "running" as const, cursor: "running" }
          }),
      }),
    )

    const result = yield* owner
      .watchTurn(turn.id, () => {
        throw new Error("consumer callback defect")
      })
      .pipe(Effect.exit)

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(Cause.pretty(result.cause)).toContain("consumer callback defect")
    expect(watches).toBe(1)
    expect(commits).toBe(1)
    expect(inspections).toBe(0)
  }),
)

it.effect("reloads the committed checkpoint when another projector makes a change stale", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
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
      baseRevision: 1,
      revision: 2,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "completed", state: "{}" },
      upsert: [],
      remove: [],
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const stale = yield* Deferred.make<void>()
    let stored: Projection | undefined
    const commits = new Array<ExecutionProjection.Change>()
    const delivered = new Array<ExecutionProjection.Change>()
    const cursors = new Array<string | undefined>()
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(stored),
        commitProjection: (_turn, change) =>
          Effect.gen(function* () {
            commits.push(change)
            if (commits.length === 1) {
              stored = {
                turn,
                units: [],
                checkpointGeneration: 1,
                revision: 1,
                state: running.state,
                projectorCheckpoint: {
                  version: ExecutionProjection.projectionVersion,
                  cursor: "winner",
                  state: "{}",
                },
                projectionVersion: ExecutionProjection.projectionVersion,
              }
              yield* Deferred.succeed(stale, undefined)
              return "stale" as const
            }
            stored = {
              turn,
              units: change._tag === "ProjectionSnapshot" ? change.units : (stored?.units ?? []),
              checkpointGeneration: (stored?.checkpointGeneration ?? 0) + 1,
              revision: change.revision,
              state: change.state,
              projectorCheckpoint: change.checkpoint,
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      }),
      ExecutionGateway.Service.of({
        watchTurn: (_link, input) => {
          cursors.push(input?.checkpoint?.cursor)
          return Stream.succeed(input?.checkpoint?.cursor === "winner" ? completed : running)
        },
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "completed" }),
      }),
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id, (change) => delivered.push(change)))
    yield* Deferred.await(stale)

    yield* TestClock.adjust("99 millis")
    expect(cursors).toEqual([undefined])
    yield* TestClock.adjust("1 millis")
    const result = yield* Fiber.join(fiber)

    expect(cursors).toEqual([undefined, "winner"])
    expect(commits).toEqual([running, completed])
    expect(delivered).toEqual([completed])
    expect(result).toMatchObject({
      status: "completed",
      state: { status: "completed" },
      checkpoint: { cursor: "completed" },
    })
  }),
)

it.effect("persists the execution link before accepting interruption", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const releaseStart = yield* Deferred.make<void>()
    const attached = yield* Deferred.make<void>()
    const owner = yield* make(
      TurnRepository.Service.of({
        prepareExecutionAdmission: (input) => Effect.succeed(input),
        attachExecutionLink: () => Deferred.succeed(attached, undefined),
      }),
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({
        startTurn: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(releaseStart)), Effect.as(link)),
      }),
    )
    const fiber = yield* Effect.forkChild(
      owner.startTurn({
        threadId: "thread",
        turnId: "turn",
        workspaceId: "/workspace",
        prompt: "work",
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
      }),
    )
    yield* Deferred.await(started)
    const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber))
    yield* Deferred.succeed(releaseStart, undefined)
    yield* Fiber.join(interruption)
    expect(yield* Deferred.isDone(attached)).toBe(true)
  }),
)

it.effect("cancels an execution attached after its turn was cancelled", () =>
  Effect.gen(function* () {
    const cancellations: Array<readonly [ExecutionGateway.ExecutionLink, string]> = []
    const owner = yield* make(
      TurnRepository.Service.of({
        prepareExecutionAdmission: (input) => Effect.succeed(input),
        attachExecutionLink: () => Effect.succeed({ ...turn, status: "cancelled" }),
      }),
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({
        startTurn: () => Effect.succeed(link),
        cancelTurn: (target, reason) => Effect.sync(() => cancellations.push([target, reason])),
      }),
    )

    expect(
      yield* owner.startTurn({
        threadId: "thread",
        turnId: "turn",
        workspaceId: "/workspace",
        prompt: "work",
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
      }),
    ).toEqual(link)
    expect(cancellations).toEqual([[link, "Cancelled before execution link attached"]])
  }),
)

it.effect("recovers every dual-database admission crash window into one idempotent TenetKit Run", () =>
  Effect.gen(function* () {
    const input: ExecutionGateway.StartTurn = {
      threadId: "thread",
      turnId: "turn",
      workspaceId: "/workspace",
      prompt: "prepared work",
      promptParts: [{ type: "text", text: "prepared work" }],
      executionRoute: ExecutionRouteSnapshot.testExecutionRoute("high"),
      titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "Prepared work" },
    }
    const scenario = Effect.fn("RootTurnOwner.testCrashWindow")(function* (
      window: "before-start" | "after-start" | "after-link",
    ) {
      let persistedInput: ExecutionGateway.StartTurn | undefined
      let persistedLink: ExecutionGateway.ExecutionLink | undefined
      let failAttach = window === "after-start"
      let startAttempts = 0
      const runs = new Map<string, { readonly input: string; readonly link: ExecutionGateway.ExecutionLink }>()
      const repository = TurnRepository.Service.of({
        prepareExecutionAdmission: (candidate: ExecutionGateway.StartTurn) =>
          Effect.gen(function* () {
            const encoded = encodeStartTurn(candidate)
            if (persistedInput !== undefined && encodeStartTurn(persistedInput) !== encoded)
              return yield* TurnRepository.RepositoryError.make({ message: "changed prepared admission" })
            persistedInput ??= structuredClone(candidate)
            return structuredClone(persistedInput)
          }),
        listUnlinkedExecutionAdmissions: Effect.sync(() =>
          persistedInput === undefined || persistedLink !== undefined ? [] : [structuredClone(persistedInput)],
        ),
        attachExecutionLink: (_turnId: Turn.TurnId, candidate: ExecutionGateway.ExecutionLink) =>
          Effect.gen(function* () {
            if (failAttach) {
              failAttach = false
              return yield* TurnRepository.RepositoryError.make({ message: "simulated process loss before link" })
            }
            persistedLink = structuredClone(candidate)
            return { ...turn, executionLink: persistedLink }
          }),
      })
      const gateway = ExecutionGateway.Service.of({
        startTurn: (candidate: ExecutionGateway.StartTurn) =>
          Effect.gen(function* () {
            startAttempts += 1
            const encoded = encodeStartTurn(candidate)
            const existing = runs.get(candidate.turnId)
            if (existing !== undefined) {
              if (existing.input !== encoded)
                return yield* ExecutionGateway.StartTurnFailure.make({ message: "changed TenetKit admission" })
              return existing.link
            }
            const executionLink = {
              runId: `opaque-${runs.size + 1}`,
              turnId: candidate.turnId,
              threadId: candidate.threadId,
            }
            runs.set(candidate.turnId, { input: encoded, link: executionLink })
            return executionLink
          }),
      })
      const owner = yield* make(repository, TranscriptRepository.Service.of({}), gateway)
      if (window === "before-start") yield* repository.prepareExecutionAdmission(input, 1)
      else yield* Effect.result(owner.startTurn(input))
      const recovered = yield* make(repository, TranscriptRepository.Service.of({}), gateway)
      yield* recovered.recoverExecutionAdmissions
      expect(runs.size).toBe(1)
      expect(persistedInput).toEqual(input)
      expect(persistedLink).toEqual({ runId: "opaque-1", turnId: "turn", threadId: "thread" })
      expect(startAttempts).toBe(window === "after-start" ? 2 : 1)
    })
    yield* scenario("before-start")
    yield* scenario("after-start")
    yield* scenario("after-link")
  }),
)

it.effect("retries a failed execution admission without blocking unrelated recovery", () =>
  Effect.gen(function* () {
    const admission = (id: string): ExecutionGateway.StartTurn => ({
      threadId: `thread-${id}`,
      turnId: `turn-${id}`,
      workspaceId: `/workspace-${id}`,
      prompt: id,
      executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    })
    const stale = admission("stale")
    const current = admission("current")
    const attempts: Array<string> = []
    const attached: Array<string> = []
    const repository = TurnRepository.Service.of({
      listUnlinkedExecutionAdmissions: Effect.succeed([stale, current]),
      attachExecutionLink: (turnId: Turn.TurnId, executionLink: ExecutionGateway.ExecutionLink) =>
        Effect.sync(() => {
          attached.push(turnId)
          return {
            ...turn,
            id: turnId,
            threadId: Thread.ThreadId.make(executionLink.threadId),
            executionLink,
          }
        }),
    })
    const gateway = ExecutionGateway.Service.of({
      startTurn: (input: ExecutionGateway.StartTurn) =>
        Effect.gen(function* () {
          attempts.push(input.turnId)
          if (input.turnId === stale.turnId)
            return yield* ExecutionGateway.StartTurnFailure.make({ message: "stale assignment" })
          return { runId: `run-${input.turnId}`, turnId: input.turnId, threadId: input.threadId }
        }),
    })
    const owner = yield* make(repository, TranscriptRepository.Service.of({}), gateway)
    const recovery = yield* Effect.forkChild(owner.recoverExecutionAdmissions)
    yield* TestClock.adjust("1 second")
    yield* Fiber.join(recovery)
    expect(attempts.filter((turnId) => turnId === stale.turnId)).toHaveLength(4)
    expect(attempts.filter((turnId) => turnId === current.turnId)).toHaveLength(1)
    expect(attached).toEqual(["turn-current"])
  }),
)

it.effect("retries unknown steering admissions with one identity and journals definitive rejection", () =>
  Effect.gen(function* () {
    const queued = (id: string): Turn.AgentExecutionTurn => {
      const { executionLink: _executionLink, ...base } = turn
      return { ...base, id: Turn.TurnId.make(id), prompt: `queued ${id}`, status: "queued" }
    }
    const target = { ...link, turnId: "target" }
    const repository = (requestId: string, source?: Turn.AgentExecutionTurn) => {
      const admission: TurnRepositorySteering.SteeringAdmission = {
        target,
        input: { text: source?.prompt ?? `direct ${requestId}`, idempotencyKey: requestId },
        source,
        preparedAt: 1,
        outcome: { _tag: "Pending" },
      }
      let admissions: ReadonlyArray<TurnRepositorySteering.SteeringAdmission> = [admission]
      return TurnRepository.Service.of({
        listSteeringAdmissions: Effect.sync(() => admissions),
        acceptSteeringAdmission: (_requestId: string, receipt: ExecutionGateway.SteeringReceipt) =>
          Effect.sync(() => {
            const accepted = { ...admission, outcome: { _tag: "Accepted" as const, receipt } }
            admissions = [accepted]
            return accepted
          }),
        rejectSteeringAdmission: (_requestId: string, failure: ExecutionGateway.SteeringFailure) =>
          Effect.sync(() => {
            const queue =
              source === undefined
                ? undefined
                : {
                    threadId: source.threadId,
                    revision: 2,
                    queuedCount: 1,
                    becameNonempty: true,
                    change: { _tag: "Added" as const, turn: source },
                  }
            const rejected = {
              ...admission,
              outcome: { _tag: "Rejected" as const, failure, queue },
            }
            admissions = [rejected]
            return rejected
          }),
        completeSteeringAdmission: () => Effect.sync(() => (admissions = [])),
        completeRejectedSteeringAdmission: () =>
          Effect.sync(() => {
            admissions = []
            return true
          }),
      })
    }
    const unknownSource = queued("unknown-source")
    const unknownRepository = repository("request-unknown", unknownSource)
    const attempts: Array<ExecutionGateway.SteeringInput> = []
    let unknown = true
    const retryingOwner = yield* make(
      unknownRepository,
      TranscriptRepository.Service.of({ get: () => Effect.void }),
      ExecutionGateway.Service.of({
        steerTurn: (_target, input) =>
          Effect.gen(function* () {
            attempts.push(input)
            if (unknown) {
              unknown = false
              return yield* ExecutionGateway.SteeringFailure.make({ kind: "unknown", message: "connection lost" })
            }
            return { entryId: "entry-unknown", sequence: 1 }
          }),
      }),
    )
    expect(yield* retryingOwner.recoverSteeringAdmissions).toMatchObject({ completed: [], rejected: [], pending: true })
    expect(yield* unknownRepository.listSteeringAdmissions).toHaveLength(1)
    expect(yield* retryingOwner.recoverSteeringAdmissions).toMatchObject({
      completed: [
        {
          admission: { input: { idempotencyKey: "request-unknown" } },
          receipt: { entryId: "entry-unknown", sequence: 1 },
          notify: true,
        },
      ],
      rejected: [],
      pending: false,
    })
    expect(yield* retryingOwner.recoverSteeringAdmissions).toMatchObject({
      completed: [],
      pending: false,
    })
    expect(attempts).toEqual([
      { text: unknownSource.prompt, idempotencyKey: "request-unknown" },
      { text: unknownSource.prompt, idempotencyKey: "request-unknown" },
    ])
    expect(yield* unknownRepository.listSteeringAdmissions).toEqual([])

    const rejectedSource = queued("rejected-source")
    const rejectedRepository = repository("request-rejected", rejectedSource)
    const rejectingOwner = yield* make(
      rejectedRepository,
      TranscriptRepository.Service.of({ get: () => Effect.void }),
      ExecutionGateway.Service.of({
        steerTurn: () => ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "turn settled" }),
      }),
    )
    expect(yield* rejectingOwner.recoverSteeringAdmissions).toMatchObject({
      completed: [],
      rejected: [
        {
          admission: { input: { idempotencyKey: "request-rejected" } },
          queue: { change: { _tag: "Added", turn: { id: rejectedSource.id, status: "queued" } } },
          failure: { kind: "rejected" },
          notify: true,
        },
      ],
      pending: true,
    })
    expect(yield* rejectedRepository.listSteeringAdmissions).toMatchObject([
      { outcome: { _tag: "Rejected", failure: { kind: "rejected" } } },
    ])
    expect(yield* rejectingOwner.recoverSteeringAdmissions).toMatchObject({
      rejected: [{ admission: { input: { idempotencyKey: "request-rejected" } }, notify: false }],
      pending: true,
    })
    yield* rejectingOwner.acknowledgeSteeringRejection(turn.threadId, "request-rejected")
    expect(yield* rejectedRepository.listSteeringAdmissions).toEqual([])

    const oversizedSource = {
      ...queued("oversized-source"),
      prompt: "x".repeat(ExecutionGateway.SteeringTextMaxCharacters + 1),
    }
    const oversizedRepository = repository("request-oversized", oversizedSource)
    let oversizedAttempts = 0
    const oversizedOwner = yield* make(
      oversizedRepository,
      TranscriptRepository.Service.of({ get: () => Effect.void }),
      ExecutionGateway.Service.of({
        steerTurn: () =>
          Effect.sync(() => {
            oversizedAttempts += 1
            return { entryId: "entry-oversized", sequence: 2 }
          }),
      }),
    )
    expect(yield* oversizedOwner.recoverSteeringAdmissions).toMatchObject({
      completed: [{ admission: { source: { id: oversizedSource.id } } }],
      pending: false,
    })
    expect(oversizedAttempts).toBe(1)
    expect(yield* oversizedRepository.listSteeringAdmissions).toEqual([])
  }),
)

it.effect("finalizes the source queue row when TenetKit accepts steering", () =>
  Effect.gen(function* () {
    const input = { text: "durable steering", idempotencyKey: "durable-request" }
    let admission: TurnRepositorySteering.SteeringAdmission | undefined = {
      target: link,
      input,
      preparedAt: 1,
      outcome: { _tag: "Pending" },
    }
    let attempts = 0
    let completions = 0
    const repository = TurnRepository.Service.of({
      listSteeringAdmissions: Effect.sync(() => (admission === undefined ? [] : [admission])),
      acceptSteeringAdmission: (_requestId: string, receipt: ExecutionGateway.SteeringReceipt) =>
        Effect.sync(() => {
          admission = { ...admission!, outcome: { _tag: "Accepted", receipt } }
          return admission
        }),
      completeSteeringAdmission: () =>
        Effect.sync(() => {
          completions += 1
          admission = undefined
        }),
    })
    const owner = yield* make(
      repository,
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({
        steerTurn: () =>
          Effect.sync(() => {
            attempts += 1
            return { entryId: "opaque-entry", sequence: 9 }
          }),
      }),
    )

    expect(yield* owner.recoverSteeringAdmissions).toMatchObject({
      completed: [{ receipt: { entryId: "opaque-entry", sequence: 9 }, notify: true }],
      rejected: [],
      pending: false,
    })
    expect(yield* owner.recoverSteeringAdmissions).toEqual({ completed: [], rejected: [], pending: false })
    expect(attempts).toBe(1)
    expect(completions).toBe(1)
    expect(admission).toBeUndefined()
  }),
)

it.effect("does not accept a terminal projection while the durable parent run remains nonterminal", () =>
  Effect.gen(function* () {
    const completedProjection = {
      turn,
      units: [
        {
          key: "child:first",
          turnId: turn.id,
          order: unitOrder("child:first", 0),
          revision: 1,
          content: { _tag: "Entry" as const, role: "assistant" as const, text: "first child completed" },
        },
        {
          key: "child:second",
          turnId: turn.id,
          order: unitOrder("child:second", 1),
          revision: 1,
          content: { _tag: "Entry" as const, role: "assistant" as const, text: "second child completed" },
        },
      ],
      checkpointGeneration: 1,
      revision: 1,
      state: {
        status: "completed" as const,
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
      projectorCheckpoint: { version: ExecutionProjection.projectionVersion, cursor: "durable", state: "{}" },
      projectionVersion: 1,
    }
    let durableStatus: "waiting" | "completed" = "waiting"
    let starts = 0
    let promotions = 0
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(completedProjection),
        commitProjection: () => Effect.succeed("committed" as const),
      }),
      ExecutionGateway.Service.of({
        startTurn: () => Effect.sync(() => ((starts += 1), link)),
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: durableStatus, cursor: "durable" }),
      }),
    )

    const waiting = yield* owner.watchTurn(turn.id)
    expect(waiting.status).toBe("waiting")
    expect(waiting.units).toHaveLength(2)
    yield* settleInteractiveSubmission(
      {
        setTurnStatus: () => Effect.succeed(turn),
        settleThread: () => Effect.sync(() => (promotions += 1)),
        emit: () => undefined,
      },
      {
        thread: {
          id: turn.threadId,
          workspace: "/workspace",
          title: "thread",
          labels: [],
          pinned: false,
          archived: false,
          lineage: { _tag: "Original" },
          createdAt: 0,
          updatedAt: 0,
        },
        turn,
        outcome: Exit.succeed(waiting),
        dispatch: () => undefined,
      },
    )
    expect(promotions).toBe(0)
    expect(starts).toBe(0)

    durableStatus = "completed"
    const completed = yield* owner.watchTurn(turn.id)
    yield* settleInteractiveSubmission(
      {
        setTurnStatus: () => Effect.succeed(turn),
        settleThread: () => Effect.sync(() => (promotions += 1)),
        emit: () => undefined,
      },
      {
        thread: {
          id: turn.threadId,
          workspace: "/workspace",
          title: "thread",
          labels: [],
          pinned: false,
          archived: false,
          lineage: { _tag: "Original" },
          createdAt: 0,
          updatedAt: 0,
        },
        turn,
        outcome: Exit.succeed(completed),
        dispatch: () => undefined,
      },
    )
    expect(completed.status).toBe("completed")
    expect(promotions).toBe(1)
    expect(starts).toBe(0)
  }),
)

it.effect("falls back to the persisted running status when the backend run is unavailable", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({ get: () => Effect.void }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "unavailable" as const }),
      }),
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("running")
    expect(result.state.status).toBe("running")
  }),
)

it.effect("keeps preview traffic out of the transcript repository and final result", () =>
  Effect.gen(function* () {
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "preview-completed", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const previews: ReadonlyArray<ExecutionGateway.ModelPreviewEvent> = Array.from({ length: 100 }, (_, index) => ({
      _tag: "ModelPreview",
      runId: link.runId,
      attemptFence: 1,
      turn: 0,
      modelCallId: "call",
      modelAttemptId: "attempt",
      attempt: 0,
      sequence: index,
      changes: [{ channel: "text", offset: index, delta: "x" }],
    }))
    const execute = Effect.fn("RootTurnOwner.testPreviewNonAuthority")(function* (enabled: boolean) {
      let stored: Projection | undefined
      const commits: Array<ExecutionProjection.Change> = []
      const delivered: Array<ExecutionProjection.Change | ExecutionGateway.ModelPreviewEvent> = []
      const owner = yield* make(
        TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
        TranscriptRepository.Service.of({
          get: () => Effect.succeed(stored),
          commitProjection: (_turn, change) =>
            Effect.sync(() => {
              commits.push(change)
              stored = {
                turn,
                units: change._tag === "ProjectionSnapshot" ? change.units : change.upsert,
                checkpointGeneration: commits.length,
                revision: change.revision,
                state: change.state,
                projectorCheckpoint: change.checkpoint,
                projectionVersion: ExecutionProjection.projectionVersion,
              }
              return "committed" as const
            }),
        }),
        ExecutionGateway.Service.of({
          watchTurn: () => Stream.fromIterable(enabled ? [...previews, completed] : [completed]),
          inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "preview-completed" }),
        }),
      )
      const result = yield* owner.watchTurn(
        turn.id,
        (change) => delivered.push(change),
        (preview) => delivered.push(preview),
      )
      return { commits, delivered, result }
    })

    const observed = yield* execute(true)
    const baseline = yield* execute(false)
    expect(observed.delivered).toHaveLength(101)
    expect(observed.delivered.filter((event) => event._tag === "ModelPreview")).toHaveLength(100)
    expect(observed.commits).toEqual([completed])
    expect(baseline.commits).toEqual([completed])
    expect(observed.result).toEqual(baseline.result)
  }),
)

it.effect("keeps late accepted callbacks behind a quiesced Thread fence", () =>
  Effect.gen(function* () {
    let launches = 0
    const owner = yield* make(
      TurnRepository.Service.of({
        get: () => Effect.succeed(turn),
        list: () => Effect.succeed([turn]),
      }),
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({}),
    )
    yield* owner.install({ run: () => Effect.sync(() => (launches += 1)).pipe(Effect.asVoid) })
    expect(yield* owner.claim(turn.id, "running")).toBe(true)
    yield* owner.quiesceThread(turn.threadId)
    yield* owner.accepted(turn.threadId, turn.id)
    yield* Effect.yieldNow
    expect(launches).toBe(0)
  }),
)

it.effect("claims a terminal turn only while its recovered status still matches", () =>
  Effect.gen(function* () {
    let current: Turn.AgentExecutionTurn = { ...turn, status: "completed" }
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(current) }),
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({}),
    )

    expect(yield* owner.claim(turn.id)).toBe(false)
    expect(yield* owner.claim(turn.id, "failed")).toBe(false)
    expect(yield* owner.claim(turn.id, "completed")).toBe(true)
    expect(yield* owner.release(turn.threadId, turn.id)).toBe(false)

    current = { ...current, status: "failed" }
    expect(yield* owner.claim(turn.id, "completed")).toBe(false)
  }),
)

it.effect("settles a terminal Run only from a matching stored projection cursor", () =>
  Effect.gen(function* () {
    const projection: Projection = {
      turn: { ...turn, status: "completed" },
      units: [],
      checkpointGeneration: 1,
      revision: 1,
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
      projectorCheckpoint: { version: ExecutionProjection.projectionVersion, cursor: "terminal", state: "{}" },
      projectionVersion: ExecutionProjection.projectionVersion,
    }
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({ get: () => Effect.succeed(projection) }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "terminal" }),
      }),
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("completed")
    expect(result.state.status).toBe("completed")
    expect(result.checkpoint?.cursor).toBe("terminal")
  }),
)

it.effect("replays a stale running cursor before returning a coherent terminal projection", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "running", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "running",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const terminalUnit = {
      key: "assistant:terminal",
      turnId: turn.id,
      order: unitOrder("assistant:terminal", 0),
      revision: 1,
      content: { _tag: "Entry" as const, role: "assistant" as const, text: "terminal answer" },
    }
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionPatch",
      baseRevision: 1,
      revision: 2,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "terminal", state: "{}" },
      upsert: [terminalUnit],
      remove: [],
      state: {
        status: "completed",
        usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: true },
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    let stored: Projection | undefined
    const cursors = new Array<string | undefined>()
    const commits = new Array<ExecutionProjection.Change>()
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(stored),
        commitProjection: (_turn, change) =>
          Effect.sync(() => {
            commits.push(change)
            stored = {
              turn,
              units: change._tag === "ProjectionSnapshot" ? change.units : change.upsert,
              checkpointGeneration: commits.length,
              revision: change.revision,
              state: change.state,
              projectorCheckpoint: change.checkpoint,
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      }),
      ExecutionGateway.Service.of({
        watchTurn: (_link, input) => {
          cursors.push(input?.checkpoint?.cursor)
          return Stream.succeed(input?.checkpoint?.cursor === "running" ? completed : running)
        },
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "terminal" }),
      }),
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id))
    yield* Effect.yieldNow
    yield* TestClock.adjust("100 millis")
    yield* Effect.yieldNow
    const result = yield* Fiber.join(fiber)

    expect(cursors).toEqual([undefined, "running"])
    expect(commits).toEqual([running, completed])
    expect(result).toMatchObject({
      status: "completed",
      state: { status: "completed", usage: { sourceComplete: true } },
      units: [{ content: { text: "terminal answer" } }],
      checkpoint: { cursor: "terminal" },
    })
  }),
)

it.effect("falls back to the persisted running status when the backend run is unavailable", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({ get: () => Effect.void }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "unavailable" as const }),
      }),
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("running")
    expect(result.state.status).toBe("running")
  }),
)

it.effect("does not authorize a terminal result when TenetKit inspection is unavailable", () =>
  Effect.gen(function* () {
    const completedTurn = { ...turn, status: "completed" as const }
    const projection: Projection = {
      turn: completedTurn,
      units: [],
      checkpointGeneration: 1,
      revision: 1,
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
      projectorCheckpoint: {
        version: ExecutionProjection.projectionVersion,
        cursor: "local-terminal",
        state: "{}",
      },
      projectionVersion: ExecutionProjection.projectionVersion,
    }
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(completedTurn) }),
      TranscriptRepository.Service.of({ get: () => Effect.succeed(projection) }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "unavailable" as const }),
      }),
    )

    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("running")
    expect(result.state.status).toBe("running")
    expect(result.checkpoint?.cursor).toBe("local-terminal")
  }),
)

it.effect("withholds an emitted terminal projection until matching TenetKit inspection succeeds", () =>
  Effect.gen(function* () {
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "terminal", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const inspected = yield* Deferred.make<void>()
    let stored: Projection | undefined
    let inspections = 0
    const commits = new Array<ExecutionProjection.Change>()
    const delivered = new Array<ExecutionProjection.Change>()
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(stored),
        commitProjection: (_turn, change) =>
          Effect.sync(() => {
            commits.push(change)
            stored = {
              turn,
              units: change._tag === "ProjectionSnapshot" ? change.units : [],
              checkpointGeneration: commits.length,
              revision: change.revision,
              state: change.state,
              projectorCheckpoint: change.checkpoint,
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.succeed(completed),
        inspectTurn: () =>
          Effect.gen(function* () {
            inspections += 1
            if (inspections === 1) {
              yield* Deferred.succeed(inspected, undefined)
              return { status: "unavailable" as const }
            }
            return { status: "completed" as const, cursor: "terminal" }
          }),
      }),
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id, (change) => delivered.push(change)))
    yield* Deferred.await(inspected)

    expect(commits).toEqual([])
    expect(delivered).toEqual([])
    yield* TestClock.adjust("99 millis")
    expect(commits).toEqual([])
    yield* TestClock.adjust("1 millis")
    const result = yield* Fiber.join(fiber)

    expect(inspections).toBe(2)
    expect(commits).toEqual([completed])
    expect(delivered).toEqual([completed])
    expect(result).toMatchObject({ status: "completed", checkpoint: { cursor: "terminal" } })
  }),
)

it.effect("reconnects after watcher failures and replays from the newest committed checkpoint", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "running-cursor", state: "{}" },
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
      baseRevision: 1,
      revision: 2,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "completed-cursor", state: "{}" },
      upsert: [],
      remove: [],
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const started = yield* Deferred.make<void>()
    let stored: Projection | undefined
    let attempts = 0
    let inspections = 0
    const cursors = new Array<string | undefined>()
    const commits = new Array<ExecutionProjection.Change>()
    const delivered = new Array<ExecutionProjection.Change>()
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(stored),
        commitProjection: (_turn, change) =>
          Effect.sync(() => {
            commits.push(change)
            stored = {
              turn,
              units: change._tag === "ProjectionSnapshot" ? change.units : (stored?.units ?? []),
              checkpointGeneration: (stored?.checkpointGeneration ?? 0) + 1,
              revision: change.revision,
              state: change.state,
              projectorCheckpoint: change.checkpoint,
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      }),
      ExecutionGateway.Service.of({
        watchTurn: (_link, input) => {
          attempts += 1
          cursors.push(input?.checkpoint?.cursor)
          if (attempts === 1)
            return Stream.fromEffect(
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(
                  Effect.fail(ExecutionGateway.WatchTurnFailure.make({ message: "watch transport failed" })),
                ),
              ),
            )
          if (attempts === 2) return Stream.die("projector defect")
          return Stream.succeed(attempts === 3 ? running : completed)
        },
        inspectTurn: () =>
          Effect.sync(() => {
            inspections += 1
            return inspections === 1
              ? ({ status: "running", cursor: "running-cursor" } as const)
              : ({ status: "completed", cursor: "completed-cursor" } as const)
          }),
      }),
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id, (change) => delivered.push(change)))
    yield* Deferred.await(started)

    yield* TestClock.adjust("99 millis")
    expect(attempts).toBe(1)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(2)
    yield* TestClock.adjust("199 millis")
    expect(attempts).toBe(2)
    yield* TestClock.adjust("1 millis")
    yield* Effect.yieldNow
    expect(attempts).toBe(3)
    expect(inspections).toBe(1)
    yield* TestClock.adjust("99 millis")
    expect(attempts).toBe(3)
    yield* TestClock.adjust("1 millis")
    yield* Effect.yieldNow

    const result = yield* Fiber.join(fiber)
    expect(attempts).toBe(4)
    expect(inspections).toBe(2)
    expect(cursors).toEqual([undefined, undefined, undefined, "running-cursor"])
    expect(commits).toEqual([running, completed])
    expect(delivered).toEqual([running, completed])
    expect(result).toMatchObject({
      status: "completed",
      state: { status: "completed" },
      checkpoint: { cursor: "completed-cursor" },
    })
  }),
)

it.effect("caps reconnect backoff at five seconds and remains interruptible", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let attempts = 0
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({ get: () => Effect.void }),
      ExecutionGateway.Service.of({
        watchTurn: () =>
          Stream.fromEffect(
            Effect.gen(function* () {
              attempts += 1
              if (attempts === 1) yield* Deferred.succeed(started, undefined)
              return yield* ExecutionGateway.WatchTurnFailure.make({ message: "still disconnected" })
            }),
          ),
      }),
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id))
    yield* Deferred.await(started)

    yield* TestClock.adjust("99 millis")
    expect(attempts).toBe(1)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(2)
    yield* TestClock.adjust("199 millis")
    expect(attempts).toBe(2)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(3)
    yield* TestClock.adjust("399 millis")
    expect(attempts).toBe(3)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(4)
    yield* TestClock.adjust("799 millis")
    expect(attempts).toBe(4)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(5)
    yield* TestClock.adjust("1599 millis")
    expect(attempts).toBe(5)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(6)
    yield* TestClock.adjust("3199 millis")
    expect(attempts).toBe(6)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(7)
    yield* TestClock.adjust("4999 millis")
    expect(attempts).toBe(7)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(8)
    yield* TestClock.adjust("4999 millis")
    expect(attempts).toBe(8)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(9)

    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }),
)

it.effect("propagates interruption while blocked at every observation boundary", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "running", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "running",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    yield* Effect.forEach(
      ["read", "watch", "commit", "inspect"] as const,
      (stage) =>
        Effect.gen(function* () {
          const blocked = yield* Deferred.make<void>()
          const block = Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never))
          const owner = yield* make(
            TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
            TranscriptRepository.Service.of({
              get: () => (stage === "read" ? block : Effect.void),
              commitProjection: () => (stage === "commit" ? block : Effect.succeed("committed" as const)),
            }),
            ExecutionGateway.Service.of({
              watchTurn: () => (stage === "watch" ? Stream.fromEffect(block) : Stream.succeed(running)),
              inspectTurn: () =>
                stage === "inspect" ? block : Effect.succeed({ status: "running" as const, cursor: "running" }),
            }),
          )
          const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id))
          yield* Deferred.await(blocked)
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }),
      { discard: true },
    )
  }),
)

it.effect("recovers typed errors and defects at every projection boundary", () =>
  Effect.gen(function* () {
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "completed-cursor", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const faults = [
      "transcript-read-error",
      "transcript-read-defect",
      "transcript-final-read-error",
      "transcript-final-read-defect",
      "transcript-commit-error",
      "transcript-commit-defect",
      "inspect-error",
      "inspect-defect",
    ] as const
    yield* Effect.forEach(
      faults,
      (fault) =>
        Effect.gen(function* () {
          const faulted = yield* Deferred.make<void>()
          let stored: Projection | undefined
          let reads = 0
          let commits = 0
          let inspections = 0
          let watches = 0
          const delivered = new Array<ExecutionProjection.Change>()
          const transcriptError = (message: string) =>
            Deferred.succeed(faulted, undefined).pipe(
              Effect.andThen(TranscriptRepository.RepositoryError.make({ message })),
            )
          const defect = (message: string) =>
            Deferred.succeed(faulted, undefined).pipe(Effect.andThen(Effect.die(message)))
          const owner = yield* make(
            TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
            TranscriptRepository.Service.of({
              get: () => {
                reads += 1
                if (reads === 1 && fault === "transcript-read-error") return transcriptError(fault)
                if (reads === 1 && fault === "transcript-read-defect") return defect(fault)
                if (reads === 2 && fault === "transcript-final-read-error") return transcriptError(fault)
                if (reads === 2 && fault === "transcript-final-read-defect") return defect(fault)
                return Effect.succeed(stored)
              },
              commitProjection: (_turn, change) => {
                commits += 1
                if (commits === 1 && fault === "transcript-commit-error") return transcriptError(fault)
                if (commits === 1 && fault === "transcript-commit-defect") return defect(fault)
                return Effect.sync(() => {
                  stored = {
                    turn,
                    units: change._tag === "ProjectionSnapshot" ? change.units : (stored?.units ?? []),
                    checkpointGeneration: (stored?.checkpointGeneration ?? 0) + 1,
                    revision: change.revision,
                    state: change.state,
                    projectorCheckpoint: change.checkpoint,
                    projectionVersion: ExecutionProjection.projectionVersion,
                  }
                  return "committed" as const
                })
              },
            }),
            ExecutionGateway.Service.of({
              watchTurn: (_link, input) => {
                watches += 1
                return input?.checkpoint?.cursor === "completed-cursor" ? Stream.empty : Stream.succeed(completed)
              },
              inspectTurn: () => {
                inspections += 1
                if (inspections === 1 && fault === "inspect-error")
                  return Deferred.succeed(faulted, undefined).pipe(
                    Effect.andThen(ExecutionGateway.InspectTurnFailure.make({ message: "inspect transport failed" })),
                  )
                if (inspections === 1 && fault === "inspect-defect") return defect(fault)
                return Effect.succeed({ status: "completed" as const, cursor: "completed-cursor" })
              },
            }),
          )
          const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id, (change) => delivered.push(change)))
          yield* Deferred.await(faulted)
          yield* Effect.yieldNow
          const watchesBeforeRetry = fault === "transcript-read-error" || fault === "transcript-read-defect" ? 0 : 1
          expect(watches).toBe(watchesBeforeRetry)
          yield* TestClock.adjust("99 millis")
          expect(watches).toBe(watchesBeforeRetry)
          yield* TestClock.adjust("1 millis")
          const result = yield* Fiber.join(fiber)

          expect(watches).toBe(watchesBeforeRetry + 1)
          expect(delivered).toEqual([completed])
          expect(result).toMatchObject({
            status: "completed",
            state: { status: "completed" },
            checkpoint: { cursor: "completed-cursor" },
          })
        }),
      { discard: true },
    )
  }),
)
