import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message, Remote } from "@rika/schema"
import { Effect, Layer, Stream } from "effect"
import { JudgeService, ThreadService, TournamentService } from "../src/index"

const sourceThreadId = Ids.ThreadId.make("thread_tournament_source")
const workspaceId = Ids.WorkspaceId.make("workspace_tournament")
const oldTurnId = Ids.TurnId.make("turn_tournament_old")
const now = Common.TimestampMillis.make(1_980_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-tournament-test",
  data_dir: "/workspace/rika-tournament-test/.rika",
  default_mode: "smart",
})

describe("TournamentService", () => {
  test("forks read-only branches, ignores copied history, and judges surviving answers", async () => {
    const startCalls: Array<Remote.StartTurnRequest> = []
    const subscriptions: Array<Remote.SubscribeThreadEventsRequest> = []
    const judgeInputs: Array<JudgeService.CompareInput> = []
    const layer = makeLayer({
      startCalls,
      subscriptions,
      judgeInputs,
      branchOutputs: ["alpha answer", "failed", "charlie answer"],
    })

    const { result, forked } = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedSourceThread()
        const tournament = yield* TournamentService.run({
          thread_id: sourceThreadId,
          message: "Compare approaches",
          branch_count: 3,
          modes: ["smart", "deep2", "deep3"],
          rubric: "Prefer concrete answers",
        })
        const records = yield* Effect.forEach(tournament.branches, (branch) =>
          ThreadService.open({ thread_id: branch.thread_id }),
        )
        return { result: tournament, forked: records }
      }).pipe(Effect.provide(layer)),
    )

    expect(startCalls.map((call) => call.tool_access)).toEqual(["read-only", "read-only", "read-only"])
    expect(startCalls.map((call) => call.content)).toEqual([
      "Compare approaches",
      "Compare approaches",
      "Compare approaches",
    ])
    expect(startCalls.map((call) => call.mode)).toEqual(["smart", "deep2", "deep3"])
    expect(subscriptions.map((input) => input.after_sequence)).toEqual([5, 5, 5])
    expect(judgeInputs).toHaveLength(1)
    expect(judgeInputs[0]).toMatchObject({
      task: "Compare approaches",
      content_kind: "answer",
      rubric: "Prefer concrete answers",
      thread_id: sourceThreadId,
    })
    expect(judgeInputs[0]?.candidates.map((candidate) => candidate.content)).toEqual(["alpha answer", "charlie answer"])
    expect(judgeInputs[0]?.candidates.every((candidate) => !candidate.content.includes("old copied answer"))).toBe(true)
    expect(result.branches.map((branch) => branch.status)).toEqual(["completed", "failed", "completed"])
    const winningBranch = result.branches[2]
    if (winningBranch === undefined) throw new Error("missing winning branch")
    expect(result.winner_thread_id).toBe(winningBranch.thread_id)
    expect(result.ranking[0]).toMatchObject({
      thread_id: winningBranch.thread_id,
      mode: "deep3",
      median_score: 10,
      strengths: "strongest",
    })
    expect(forked.map((record) => record.summary.title_text)).toEqual([
      "tournament:source/1",
      "tournament:source/2",
      "tournament:source/3",
    ])
  })

  test("fails typed when fewer than two branches survive", async () => {
    const judgeInputs: Array<JudgeService.CompareInput> = []
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedSourceThread()
        return yield* TournamentService.run({
          thread_id: sourceThreadId,
          message: "Compare approaches",
          branch_count: 3,
        }).pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          makeLayer({
            startCalls: [],
            subscriptions: [],
            judgeInputs,
            branchOutputs: ["only survivor", "failed", "failed"],
          }),
        ),
      ),
    )

    expect(error).toMatchObject({
      _tag: "TournamentError",
      reason: "insufficient_survivors",
      thread_id: sourceThreadId,
    })
    if (!(error instanceof TournamentService.TournamentError)) throw new Error("expected TournamentError")
    if (error.outcomes === undefined) throw new Error("expected tournament outcomes")
    expect(error.outcomes.map((outcome) => outcome.status)).toEqual(["completed", "failed", "failed"])
    expect(judgeInputs).toEqual([])
  })

  test("rejects a modes list that does not match the branch count", async () => {
    const error = await Effect.runPromise(
      TournamentService.run({
        thread_id: sourceThreadId,
        message: "Compare approaches",
        branch_count: 3,
        modes: ["smart", "deep2"],
      }).pipe(Effect.flip, Effect.provide(makeLayer({ startCalls: [], subscriptions: [], judgeInputs: [] }))),
    )

    expect(error).toMatchObject({
      _tag: "TournamentError",
      reason: "invalid_input",
      message: "Tournament modes count must equal branch_count",
    })
  })
})

interface LayerInput {
  readonly startCalls: Array<Remote.StartTurnRequest>
  readonly subscriptions: Array<Remote.SubscribeThreadEventsRequest>
  readonly judgeInputs: Array<JudgeService.CompareInput>
  readonly branchOutputs?: ReadonlyArray<string>
}

const makeLayer = (input: LayerInput) => {
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const baseServices = Layer.mergeAll(
    configLayer,
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
    redactorLayer,
    diagnosticsLayer,
  )
  const threadLayer = ThreadService.layer.pipe(Layer.provideMerge(baseServices), Layer.provideMerge(diagnosticsLayer))
  return TournamentService.layer.pipe(
    Layer.provideMerge(threadLayer),
    Layer.provideMerge(turnControlLayer(input)),
    Layer.provideMerge(judgeLayer(input.judgeInputs)),
    Layer.provideMerge(baseServices),
  )
}

const turnControlLayer = (input: LayerInput) =>
  TournamentService.turnControlLayer({
    startTurn: (request) =>
      Effect.sync(() => {
        input.startCalls.push(request)
        return { thread_id: request.thread_id, accepted: true }
      }),
    subscribeThreadEvents: (request) => {
      input.subscriptions.push(request)
      const branchIndex = input.subscriptions.length - 1
      const output = input.branchOutputs?.[branchIndex] ?? `answer ${branchIndex + 1}`
      return Stream.fromIterable(branchEvents(request.thread_id, request.after_sequence ?? 0, branchIndex, output))
    },
  })

const judgeLayer = (inputs: Array<JudgeService.CompareInput>) =>
  JudgeService.fakeLayer((input) =>
    Effect.sync(() => {
      inputs.push(input)
      const winner = input.candidates.at(-1) ?? input.candidates[0]
      if (winner === undefined) {
        return { winner_id: "", ranking: [], judges: [], rationale: "" }
      }
      return {
        winner_id: winner.id,
        ranking: input.candidates
          .map((candidate) => ({
            candidate_id: candidate.id,
            median_score: candidate.id === winner.id ? 10 : 7,
            first_place_votes: candidate.id === winner.id ? 1 : 0,
          }))
          .toSorted((left, right) => right.median_score - left.median_score),
        judges: [
          {
            winner_id: winner.id,
            rationale: "winner is stronger",
            scores: input.candidates.map((candidate) => ({
              candidate_id: candidate.id,
              score: candidate.id === winner.id ? 10 : 7,
              strengths: candidate.id === winner.id ? "strongest" : "solid",
              weaknesses: "none",
            })),
          },
        ],
        rationale: "winner is stronger",
      }
    }),
  )

const seedSourceThread = () =>
  Effect.forEach(
    [
      threadCreated(sourceThreadId, 1),
      turnStarted(sourceThreadId, oldTurnId, 2),
      messageAdded(sourceThreadId, oldTurnId, 3, "user", "old user request"),
      messageAdded(sourceThreadId, oldTurnId, 4, "assistant", "old copied answer"),
      turnCompleted(sourceThreadId, oldTurnId, 5),
    ],
    appendProjected,
    { discard: true },
  )

const appendProjected = (event: Event.Event) =>
  Effect.gen(function* () {
    const appended = yield* ThreadEventLog.append(event)
    yield* ThreadProjection.apply(appended)
  })

const branchEvents = (
  threadId: Ids.ThreadId,
  afterSequence: number,
  branchIndex: number,
  output: string,
): ReadonlyArray<Event.Event> => {
  const turnId = Ids.TurnId.make(`turn_tournament_branch_${branchIndex + 1}`)
  if (output === "failed") {
    return [turnStarted(threadId, turnId, afterSequence + 1), turnFailed(threadId, turnId, afterSequence + 2)]
  }
  return [
    turnStarted(threadId, turnId, afterSequence + 1),
    messageAdded(threadId, turnId, afterSequence + 2, "assistant", output),
    turnCompleted(threadId, turnId, afterSequence + 3),
  ]
}

const threadCreated = (threadId: Ids.ThreadId, sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_${threadId}_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  type: "thread.created",
  created_at: now,
  data: { workspace_id: workspaceId },
})

const turnStarted = (threadId: Ids.ThreadId, turnId: Ids.TurnId, sequence: number): Event.TurnStarted => ({
  id: Ids.EventId.make(`event_${threadId}_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  type: "turn.started",
  created_at: now,
  data: {},
})

const messageAdded = (
  threadId: Ids.ThreadId,
  turnId: Ids.TurnId,
  sequence: number,
  role: "user" | "assistant",
  content: string,
): Event.MessageAdded => ({
  id: Ids.EventId.make(`event_${threadId}_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  type: "message.added",
  created_at: now,
  data: {
    message: {
      id: Ids.MessageId.make(`message_${threadId}_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      role,
      content: [Message.text(content)],
      created_at: now,
    },
  },
})

const turnCompleted = (threadId: Ids.ThreadId, turnId: Ids.TurnId, sequence: number): Event.TurnCompleted => ({
  id: Ids.EventId.make(`event_${threadId}_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  type: "turn.completed",
  created_at: now,
  data: {},
})

const turnFailed = (threadId: Ids.ThreadId, turnId: Ids.TurnId, sequence: number): Event.TurnFailed => ({
  id: Ids.EventId.make(`event_${threadId}_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  type: "turn.failed",
  created_at: now,
  data: { error: { kind: "unknown", message: "branch failed" } },
})
