import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import type * as TurnRepositorySteering from "@rika/product/turn-repository-steering"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"

import { make } from "../../../src/thread/queue/root-owner"
import { link, turn } from "./root-owner.fixture"

const encodeStartTurn = Schema.encodeSync(Schema.fromJsonString(ExecutionGateway.StartTurn))

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

it.effect("recovers every dual-database admission crash window into one idempotent Generalist Run", () =>
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
                return yield* ExecutionGateway.StartTurnFailure.make({ message: "changed Generalist admission" })
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

it.effect("finalizes the source queue row when Generalist accepts steering", () =>
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
