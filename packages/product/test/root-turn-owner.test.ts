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
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { unitOrder } from "@rika/transcript/transcript-unit-order"

const encodeStartTurn = Schema.encodeSync(Schema.fromJsonString(ExecutionGateway.StartTurn))
import { make } from "../src/thread/queue/root-turn-owner"

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
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      {} as TranscriptRepository.Interface,
      {} as ExecutionGateway.Interface,
    )
    expect(yield* owner.claim(turn.id)).toBe(true)
    expect(yield* owner.claim(turn.id)).toBe(false)
    expect(yield* owner.release(turn.id)).toBe(true)
    expect(yield* owner.claim(turn.id)).toBe(true)
    expect(yield* owner.release(turn.id)).toBe(false)
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
      { get: () => Effect.succeed(completed) } as TurnRepository.Interface,
      {
        get: () => Effect.succeed(projection),
        commitProjection: () => Effect.succeed("committed" as const),
      } as TranscriptRepository.Interface,
      { watchTurn: () => Stream.empty } as ExecutionGateway.Interface,
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
                protocol: "openai",
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
      projectionVersion: ExecutionProjection.projectionVersion,
    }
    let receivedPricing: string | undefined
    const owner = yield* make(
      { get: () => Effect.succeed(completed) } as TurnRepository.Interface,
      {
        get: () => Effect.succeed(projection),
        commitProjection: () => Effect.succeed("committed" as const),
      } as TranscriptRepository.Interface,
      {
        watchTurn: (_link, input) => {
          receivedPricing = input?.pricing
          return Stream.empty
        },
        inspectTurn: () => Effect.succeed({ status: "completed" as const }),
      } as ExecutionGateway.Interface,
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
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      {
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
              ...(change.checkpoint === undefined ? {} : { projectorCheckpoint: change.checkpoint }),
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      } as TranscriptRepository.Interface,
      {
        watchTurn: () => {
          watches += 1
          return watches === 1 ? Stream.fromIterable([running, completed]) : Stream.empty
        },
      } as ExecutionGateway.Interface,
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

it.effect("persists the execution link before accepting interruption", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const releaseStart = yield* Deferred.make<void>()
    const attached = yield* Deferred.make<void>()
    const owner = yield* make(
      {
        prepareExecutionAdmission: (input) => Effect.succeed(input),
        attachExecutionLink: () => Deferred.succeed(attached, undefined),
      } as TurnRepository.Interface,
      {} as TranscriptRepository.Interface,
      {
        startTurn: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(releaseStart)), Effect.as(link)),
      } as ExecutionGateway.Interface,
    )
    const fiber = yield* Effect.forkChild(
      owner.startTurn({
        threadId: "thread",
        turnId: "turn",
        workspace: "/workspace",
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

it.effect("recovers every dual-database admission crash window into one idempotent Baton Run", () =>
  Effect.gen(function* () {
    const input: ExecutionGateway.StartTurn = {
      threadId: "thread",
      turnId: "turn",
      workspace: "/workspace",
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
      const repository = {
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
      } as unknown as TurnRepository.Interface
      const gateway = {
        startTurn: (candidate: ExecutionGateway.StartTurn) =>
          Effect.gen(function* () {
            startAttempts += 1
            const encoded = encodeStartTurn(candidate)
            const existing = runs.get(candidate.turnId)
            if (existing !== undefined) {
              if (existing.input !== encoded)
                return yield* ExecutionGateway.StartTurnFailure.make({ message: "changed Baton admission" })
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
      } as unknown as ExecutionGateway.Interface
      const owner = yield* make(repository, {} as TranscriptRepository.Interface, gateway)
      if (window === "before-start") yield* repository.prepareExecutionAdmission(input, 1)
      else yield* Effect.result(owner.startTurn(input))
      const recovered = yield* make(repository, {} as TranscriptRepository.Interface, gateway)
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
        ...(source === undefined ? {} : { source }),
        preparedAt: 1,
        outcome: { _tag: "Pending" },
      }
      let admissions: ReadonlyArray<TurnRepositorySteering.SteeringAdmission> = [admission]
      return {
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
              outcome: { _tag: "Rejected" as const, failure, ...(queue === undefined ? {} : { queue }) },
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
      } as unknown as TurnRepository.Interface
    }
    const unknownSource = queued("unknown-source")
    const unknownRepository = repository("request-unknown", unknownSource)
    const attempts: Array<ExecutionGateway.SteeringInput> = []
    let unknown = true
    const retryingOwner = yield* make(
      unknownRepository,
      { get: () => Effect.void } as TranscriptRepository.Interface,
      {
        steerTurn: (_target, input) =>
          Effect.gen(function* () {
            attempts.push(input)
            if (unknown) {
              unknown = false
              return yield* ExecutionGateway.SteeringFailure.make({ kind: "unknown", message: "connection lost" })
            }
            return { entryId: "entry-unknown", sequence: 1 }
          }),
      } as ExecutionGateway.Interface,
    )
    expect(yield* retryingOwner.recoverSteeringAdmissions).toEqual({ accepted: [], rejected: [], pending: true })
    expect(yield* unknownRepository.listSteeringAdmissions).toHaveLength(1)
    expect(yield* retryingOwner.recoverSteeringAdmissions).toMatchObject({
      accepted: [
        {
          admission: { input: { idempotencyKey: "request-unknown" } },
          receipt: { entryId: "entry-unknown", sequence: 1 },
        },
      ],
      rejected: [],
      pending: true,
    })
    expect(attempts).toEqual([
      { text: unknownSource.prompt, idempotencyKey: "request-unknown" },
      { text: unknownSource.prompt, idempotencyKey: "request-unknown" },
    ])
    expect(yield* unknownRepository.listSteeringAdmissions).toMatchObject([
      { outcome: { _tag: "Accepted", receipt: { entryId: "entry-unknown", sequence: 1 } } },
    ])

    const rejectedSource = queued("rejected-source")
    const rejectedRepository = repository("request-rejected", rejectedSource)
    const rejectingOwner = yield* make(
      rejectedRepository,
      { get: () => Effect.void } as TranscriptRepository.Interface,
      {
        steerTurn: () => ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "turn settled" }),
      } as ExecutionGateway.Interface,
    )
    expect(yield* rejectingOwner.recoverSteeringAdmissions).toMatchObject({
      accepted: [],
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
    yield* rejectingOwner.acknowledgeSteeringRejection("request-rejected")
    expect(yield* rejectedRepository.listSteeringAdmissions).toEqual([])

    const oversizedSource = {
      ...queued("oversized-source"),
      prompt: "x".repeat(ExecutionGateway.SteeringTextMaxCharacters + 1),
    }
    const oversizedRepository = repository("request-oversized", oversizedSource)
    let oversizedAttempts = 0
    const oversizedOwner = yield* make(
      oversizedRepository,
      { get: () => Effect.void } as TranscriptRepository.Interface,
      {
        steerTurn: () =>
          Effect.sync(() => {
            oversizedAttempts += 1
            return { entryId: "entry-oversized", sequence: 2 }
          }),
      } as ExecutionGateway.Interface,
    )
    expect(yield* oversizedOwner.recoverSteeringAdmissions).toMatchObject({
      accepted: [],
      rejected: [{ admission: { source: { id: oversizedSource.id } }, failure: { kind: "rejected" } }],
      pending: true,
    })
    expect(oversizedAttempts).toBe(0)
    expect(yield* oversizedRepository.listSteeringAdmissions).toMatchObject([
      { outcome: { _tag: "Rejected", failure: { kind: "rejected" } } },
    ])
  }),
)

it.effect("persists the Baton receipt until exact accepted, consumed, or discarded identity is observed", () =>
  Effect.gen(function* () {
    const input = { text: "durable steering", idempotencyKey: "durable-request" }
    let admission: TurnRepositorySteering.SteeringAdmission | undefined = {
      target: link,
      input,
      preparedAt: 1,
      outcome: { _tag: "Pending" },
    }
    let projection: Projection | undefined
    let attempts = 0
    const repository = {
      listSteeringAdmissions: Effect.sync(() => (admission === undefined ? [] : [admission])),
      acceptSteeringAdmission: (_requestId: string, receipt: ExecutionGateway.SteeringReceipt) =>
        Effect.sync(() => {
          admission = { ...admission!, outcome: { _tag: "Accepted", receipt } }
          return admission
        }),
      completeSteeringAdmission: () => Effect.sync(() => (admission = undefined)),
    } as unknown as TurnRepository.Interface
    const transcripts = {
      get: () => Effect.sync(() => projection),
    } as TranscriptRepository.Interface
    const owner = yield* make(repository, transcripts, {
      steerTurn: () =>
        Effect.sync(() => {
          attempts += 1
          return { entryId: "opaque-entry", sequence: 9 }
        }),
    } as ExecutionGateway.Interface)

    expect(yield* owner.recoverSteeringAdmissions).toMatchObject({
      accepted: [{ receipt: { entryId: "opaque-entry", sequence: 9 } }],
      pending: true,
    })
    expect(yield* owner.recoverSteeringAdmissions).toMatchObject({
      accepted: [{ receipt: { entryId: "opaque-entry", sequence: 9 } }],
      pending: true,
    })
    expect(attempts).toBe(1)

    const projectionState = (entryId: string): Projection =>
      ({
        units: [],
        state: {
          status: "running",
          usage: ExecutionProjection.emptyUsageState(),
          steering: {
            steeringMessages: 0,
            followUpMessages: 0,
            pending: [{ runId: link.runId, entryId, requestId: input.idempotencyKey, sequence: 9, text: input.text }],
          },
        },
      }) as Projection
    projection = projectionState("wrong-entry")
    expect(yield* Effect.result(owner.recoverSteeringAdmissions)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TurnRepositoryError" },
    })
    expect(attempts).toBe(1)

    projection = projectionState("opaque-entry")
    expect(yield* owner.recoverSteeringAdmissions).toEqual({ accepted: [], rejected: [], pending: true })
    expect(admission?.outcome._tag).toBe("Accepted")

    projection = {
      ...projection,
      state: {
        ...projection.state,
        status: "completed",
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    expect(yield* owner.recoverSteeringAdmissions).toMatchObject({
      accepted: [{ receipt: { entryId: "opaque-entry", sequence: 9 } }],
      pending: true,
    })
    expect(admission?.outcome._tag).toBe("Accepted")

    projection = {
      ...projection,
      state: {
        ...projection.state,
        status: "running",
        steering: {
          steeringMessages: 0,
          followUpMessages: 0,
          settled: [
            {
              runId: link.runId,
              entryId: "opaque-entry",
              requestId: input.idempotencyKey,
              sequence: 10,
              outcome: "discarded",
            },
          ],
        },
      },
    }
    expect(yield* Effect.result(owner.recoverSteeringAdmissions)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TurnRepositoryError" },
    })
    expect(admission?.outcome._tag).toBe("Accepted")

    projection = {
      ...projection,
      units: [
        {
          key: ExecutionProjection.steeringUnitKey(turn.id, link.runId, input.idempotencyKey, "wrong-entry", 9),
          turnId: turn.id,
          order: unitOrder("wrong-durable-steering", 0),
          revision: 1,
          content: { _tag: "Entry", role: "user", text: input.text },
        },
      ],
      state: {
        ...projection.state,
        steering: { steeringMessages: 1, followUpMessages: 0 },
      },
    }
    expect(yield* owner.recoverSteeringAdmissions).toMatchObject({
      accepted: [{ receipt: { entryId: "opaque-entry", sequence: 9 } }],
      pending: true,
    })
    expect(admission?.outcome._tag).toBe("Accepted")

    projection = {
      ...projection,
      units: [
        {
          key: ExecutionProjection.steeringUnitKey(turn.id, link.runId, input.idempotencyKey, "opaque-entry", 9),
          turnId: turn.id,
          order: unitOrder("durable-steering", 0),
          revision: 1,
          content: { _tag: "Entry", role: "user", text: input.text },
        },
      ],
      state: {
        ...projection.state,
        steering: { steeringMessages: 1, followUpMessages: 0 },
      },
    }
    expect(yield* owner.recoverSteeringAdmissions).toEqual({ accepted: [], rejected: [], pending: false })
    expect(admission).toBeUndefined()
    expect(attempts).toBe(1)

    admission = {
      target: link,
      input,
      preparedAt: 1,
      outcome: { _tag: "Accepted", receipt: { entryId: "opaque-entry", sequence: 9 } },
    }
    projection = {
      ...projection,
      units: [],
      state: {
        ...projection.state,
        steering: {
          steeringMessages: 1,
          followUpMessages: 0,
          settled: [
            {
              runId: link.runId,
              entryId: "opaque-entry",
              requestId: input.idempotencyKey,
              sequence: 9,
              outcome: "discarded",
            },
          ],
        },
      },
    }
    expect(yield* owner.recoverSteeringAdmissions).toEqual({ accepted: [], rejected: [], pending: false })
    expect(admission).toBeUndefined()
  }),
)

it.effect("settles a turn whose backend run is terminal when the watch stream yields no changes", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      { get: () => Effect.void } as TranscriptRepository.Interface,
      {
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "completed" as const }),
      } as ExecutionGateway.Interface,
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("completed")
    expect(result.state.status).toBe("completed")
  }),
)

it.effect("falls back to the persisted running status when the backend run is unavailable", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      { get: () => Effect.void } as TranscriptRepository.Interface,
      {
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "unavailable" as const }),
      } as ExecutionGateway.Interface,
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
        { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
        {
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
                ...(change.checkpoint === undefined ? {} : { projectorCheckpoint: change.checkpoint }),
                projectionVersion: ExecutionProjection.projectionVersion,
              }
              return "committed" as const
            }),
        } as TranscriptRepository.Interface,
        {
          watchTurn: () => Stream.fromIterable(enabled ? [...previews, completed] : [completed]),
        } as ExecutionGateway.Interface,
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
      {
        get: () => Effect.succeed(turn),
        list: () => Effect.succeed([turn]),
      } as TurnRepository.Interface,
      {} as TranscriptRepository.Interface,
      {} as ExecutionGateway.Interface,
    )
    yield* owner.install({ run: () => Effect.sync(() => (launches += 1)).pipe(Effect.asVoid) })
    expect(yield* owner.claim(turn.id, "running")).toBe(true)
    yield* owner.quiesceThread(turn.threadId)
    yield* owner.accepted(turn.id)
    yield* Effect.yieldNow
    expect(launches).toBe(0)
  }),
)
