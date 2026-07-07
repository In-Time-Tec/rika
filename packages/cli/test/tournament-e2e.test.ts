import { describe, expect, test } from "bun:test"
import {
  AgentLoop,
  CompactionService,
  ContextResolver,
  JudgeService,
  SkillRegistry,
  ThreadService,
  ToolExecutor,
  TournamentService,
  WorkspaceAccess,
} from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { Provider, Router } from "@rika/llm"
import { OrbManager } from "@rika/orb"
import {
  ArtifactStore,
  Database,
  Migration,
  OrbStore,
  ProjectStore,
  ThreadEventLog,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { Common, Ids, Orb } from "@rika/schema"
import { OrbMirror, PresenceHub, RemoteControl, ThreadLive } from "@rika/server"
import { Effect, Layer, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import { Input, Output, Threads } from "../src/index"

const sourceThreadId = Ids.ThreadId.make("thread_cli_tournament_e2e_source")
const workspaceId = Ids.WorkspaceId.make("workspace_cli_tournament_e2e")
const projectId = Ids.ProjectId.make("project_cli_tournament_e2e")
const orbId = Ids.OrbId.make("orb_cli_tournament_e2e")
const now = Common.TimestampMillis.make(1_966_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-cli-tournament-e2e",
  data_dir: "/workspace/rika-cli-tournament-e2e/.rika",
  default_mode: "smart",
})

describe("CLI thread tournament e2e", () => {
  test("forks three read-only branches, judges scripted answers, stores a verdict, and prints the winner", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const judgeInputs: Array<JudgeService.CompareInput> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadService.create({ thread_id: sourceThreadId, workspace_id: workspaceId })
        const exitCode = yield* Threads.executeCommand({
          type: "threads",
          action: "tournament",
          thread_id: sourceThreadId,
          message: "pick the most concrete answer",
          branch_count: 3,
          modes: ["smart", "deep2", "deep3"],
        })
        const artifacts = yield* ArtifactStore.list({ thread_id: sourceThreadId, kind: "verdict" })
        const summaries = yield* ThreadService.list({ include_archived: true })
        return { exitCode, artifacts, summaries }
      }).pipe(
        Effect.provide(
          makeLayer({
            output,
            judgeInputs,
            answers: ["brief answer", "detailed answer", "most concrete answer"],
          }),
        ),
      ),
    )

    expect(result.exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout[0]).toContain("Rank\tThread\tMode\tScore\tStrengths")
    expect(output.stdout[0]).toContain("Winner\t")
    expect(output.stdout[0]).toContain("rika --thread")
    expect(branchSummaries(result.summaries)).toEqual([
      ["tournament:source/1", "completed", "brief answer"],
      ["tournament:source/2", "completed", "detailed answer"],
      ["tournament:source/3", "completed", "most concrete answer"],
    ])
    expect(judgeInputs).toHaveLength(1)
    expect(judgeInputs[0]?.candidates.map((candidate) => candidate.content).toSorted()).toEqual([
      "brief answer",
      "detailed answer",
      "most concrete answer",
    ])
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]?.metadata).toMatchObject({ candidate_count: 3, judge_count: 1 })
    expect(
      result.summaries
        .map((summary) => summary.title_text)
        .filter((title): title is string => title !== undefined)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["tournament:source/1", "tournament:source/2", "tournament:source/3"])
  })

  test("judges the remaining branches when one branch turn fails", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const judgeInputs: Array<JudgeService.CompareInput> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadService.create({ thread_id: sourceThreadId, workspace_id: workspaceId })
        const exitCode = yield* Threads.executeCommand({
          type: "threads",
          action: "tournament",
          thread_id: sourceThreadId,
          message: "survive one model failure",
          branch_count: 3,
        })
        const summaries = yield* ThreadService.list({ include_archived: true })
        return { exitCode, summaries }
      }).pipe(
        Effect.provide(
          makeLayer({
            output,
            judgeInputs,
            answers: ["survivor one", "survivor two"],
            failBranchOrdinals: new Set([2]),
          }),
        ),
      ),
    )

    expect(result.exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(judgeInputs[0]?.candidates.map((candidate) => candidate.content).toSorted()).toEqual([
      "survivor one",
      "survivor two",
    ])
    expect(result.summaries.filter((summary) => summary.active_turn_status === "failed")).toHaveLength(1)
    expect(result.summaries.filter((summary) => summary.active_turn_status === "completed")).toHaveLength(2)
  })

  test("fails with a typed tournament error when fewer than two branches survive", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const judgeInputs: Array<JudgeService.CompareInput> = []

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadService.create({ thread_id: sourceThreadId, workspace_id: workspaceId })
        return yield* Threads.executeCommand({
          type: "threads",
          action: "tournament",
          thread_id: sourceThreadId,
          message: "fail two branches",
          branch_count: 3,
        })
      }).pipe(
        Effect.flip,
        Effect.provide(
          makeLayer({
            output,
            judgeInputs,
            answers: ["only survivor"],
            failBranchOrdinals: new Set([1, 3]),
          }),
        ),
      ),
    )

    expect(error).toMatchObject({
      _tag: "TournamentError",
      reason: "insufficient_survivors",
      thread_id: sourceThreadId,
    })
    expect(judgeInputs).toEqual([])
    expect(output.stdout).toEqual([])
  })
})

const branchSummaries = (summaries: ReadonlyArray<ThreadService.ThreadSummary>) =>
  summaries
    .filter((summary) => summary.title_text?.startsWith("tournament:source/") === true)
    .map((summary) => [summary.title_text, summary.active_turn_status, summary.latest_message_text])
    .toSorted((left, right) => String(left[0]).localeCompare(String(right[0])))

interface LayerInput {
  readonly output: Output.MemoryOutput
  readonly judgeInputs: Array<JudgeService.CompareInput>
  readonly answers: ReadonlyArray<string>
  readonly failBranchOrdinals?: ReadonlySet<number>
  readonly stdin?: string
}

const makeLayer = (input: LayerInput) => {
  const timeLayer = Time.fixedLayer(now)
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const baseStorageLayer = Layer.mergeAll(
    configLayer,
    Output.memoryLayer(input.output),
    Input.memoryLayer(input.stdin ?? "", false),
    Database.memoryLayer,
    Migration.layer,
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.sequenceLayer(1),
    diagnosticsLayer,
  )
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(baseStorageLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(baseStorageLayer))
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(baseStorageLayer),
  )
  const orbStoreLayer = OrbStore.layer.pipe(Layer.provideMerge(baseStorageLayer))
  const storageLayer = Layer.mergeAll(
    baseStorageLayer,
    artifactLayer,
    workspaceStoreLayer,
    projectStoreLayer,
    orbStoreLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const threadLayer = ThreadService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(fakeProviderRegistryLayer(input.answers, input.failBranchOrdinals ?? new Set())),
  )
  const agentBaseLayer = Layer.mergeAll(
    migratedStorageLayer,
    threadLayer,
    workspaceAccessLayer,
    ContextResolver.fakeLayer({ entries: [], rendered: "", total_chars: 0 }),
    SkillRegistry.emptyLayer,
    ToolExecutor.fakeLayer({}).pipe(Layer.provideMerge(diagnosticsLayer)),
    diagnosticsLayer,
    llmLayer,
    IdeBridge.layer,
    fakeOrbManagerLayer,
    fakeOrbMirrorLayer,
  )
  const compactionLayer = CompactionService.fakeLayer({
    compact: (request) =>
      Effect.fail(
        new CompactionService.CompactionError({
          message: "Compaction is not part of the tournament e2e fixture",
          operation: "compact",
          thread_id: request.thread_id,
        }),
      ),
  })
  const agentLoopLayer = AgentLoop.layer.pipe(Layer.provideMerge(agentBaseLayer))
  const threadLiveLayer = ThreadLive.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const presenceLayer = PresenceHub.layer.pipe(Layer.provideMerge(timeLayer))
  const remoteControlLayer = RemoteControl.layerWithLive.pipe(
    Layer.provideMerge(agentLoopLayer),
    Layer.provideMerge(compactionLayer),
    Layer.provideMerge(agentBaseLayer),
    Layer.provideMerge(threadLiveLayer),
    Layer.provideMerge(presenceLayer),
  )
  const tournamentTurnControlLayer = Layer.effect(
    TournamentService.TurnControlService,
    Effect.map(RemoteControl.Service, (remote) =>
      TournamentService.TurnControlService.of({
        startTurn: (request) =>
          remote.startTurn(request).pipe(
            Effect.mapError(
              (error) =>
                new TournamentService.TournamentTurnError({
                  message: error instanceof Error ? error.message : String(error),
                  operation: "startTurn",
                  thread_id: request.thread_id,
                  cause: error,
                }),
            ),
          ),
        subscribeThreadEvents: (request) =>
          remote.subscribeThreadEvents(request).pipe(
            Stream.mapError(
              (error) =>
                new TournamentService.TournamentTurnError({
                  message: error instanceof Error ? error.message : String(error),
                  operation: "subscribeThreadEvents",
                  thread_id: request.thread_id,
                  cause: error,
                }),
            ),
          ),
      }),
    ),
  ).pipe(Layer.provideMerge(remoteControlLayer))
  const tournamentLayer = TournamentService.layer.pipe(
    Layer.provideMerge(threadLayer),
    Layer.provideMerge(fakeJudgeLayer(input.judgeInputs)),
    Layer.provideMerge(tournamentTurnControlLayer),
    Layer.provideMerge(configLayer),
  )

  return Threads.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(threadLayer),
    Layer.provideMerge(tournamentLayer),
  )
}

const fakeProviderRegistryLayer = (
  answers: ReadonlyArray<string>,
  failBranchOrdinals: ReadonlySet<number>,
): Layer.Layer<Provider.Registry> => {
  let answerIndex = 0
  const branchOrdinals = new Map<string, number>()
  const ordinalFor = (request: Provider.GenerateRequest) => {
    const threadId = request.metadata?.thread_id ?? `unknown-${branchOrdinals.size + 1}`
    const existing = branchOrdinals.get(threadId)
    if (existing !== undefined) return existing
    const next = branchOrdinals.size + 1
    branchOrdinals.set(threadId, next)
    return next
  }
  const providerNamed = (name: Provider.ProviderName) =>
    Provider.Service.of({
      name,
      complete: () =>
        Effect.succeed({
          provider: name,
          model: "fake-tournament",
          content: answers[answerIndex] ?? "answer",
          finish_reason: "stop",
        }),
      completeStructured: () => Effect.die(new Error("Tournament e2e uses JudgeService.fakeLayer")),
      stream: (request) =>
        Stream.unwrap(
          Effect.sync(() => {
            const ordinal = ordinalFor(request)
            if (failBranchOrdinals.has(ordinal)) {
              return Stream.fail(
                AiError.make({
                  module: "LanguageModel",
                  method: "streamText",
                  reason: new AiError.InvalidOutputError({ description: `branch ${ordinal} failed` }),
                }),
              )
            }
            const content = answers[answerIndex] ?? `answer ${answerIndex + 1}`
            answerIndex += 1
            return Stream.fromIterable(
              Provider.streamEventsFromResponse({
                provider: name,
                model: "fake-tournament",
                content,
                finish_reason: "stop",
              }),
            )
          }),
        ),
    })
  return Provider.registryLayerFromProviders([providerNamed("anthropic"), providerNamed("openai")])
}

const fakeJudgeLayer = (inputs: Array<JudgeService.CompareInput>) =>
  Layer.effect(
    JudgeService.Service,
    Effect.gen(function* () {
      const artifactStore = yield* ArtifactStore.Service
      const idGenerator = yield* IdGenerator.Service
      const time = yield* Time.Service
      return JudgeService.Service.of({
        compare: Effect.fn("Cli.TournamentE2E.Judge.compare")(function* (input: JudgeService.CompareInput) {
          inputs.push(input)
          const winner = input.candidates.at(-1)
          if (winner === undefined) {
            return yield* new JudgeService.JudgeError({
              message: "Fake judge requires candidates",
              operation: "compare",
            })
          }
          const verdict = {
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
                rationale: "last surviving branch wins",
                scores: input.candidates.map((candidate) => ({
                  candidate_id: candidate.id,
                  score: candidate.id === winner.id ? 10 : 7,
                  strengths: candidate.id === winner.id ? "best survivor" : "acceptable",
                  weaknesses: "none",
                })),
              },
            ],
            rationale: "last surviving branch wins",
          }
          yield* artifactStore.put({
            id: Ids.ArtifactId.make(yield* idGenerator.next("artifact")),
            thread_id: input.thread_id,
            kind: "verdict",
            title: "Judge verdict",
            content: verdict,
            created_at: yield* time.nowMillis,
            metadata: {
              winner_id: verdict.winner_id,
              candidate_count: input.candidates.length,
              judge_count: 1,
            },
          })
          return verdict
        }),
      })
    }),
  )

const fakeOrbManagerLayer = Layer.succeed(
  OrbManager.Service,
  OrbManager.Service.of({
    provisionForThread: (input) => Effect.succeed(orbRecord(input.thread_id, input.project_id, "running")),
    pause: (id) => Effect.succeed(orbRecord(sourceThreadId, projectId, "paused", id)),
    resume: (id) => Effect.succeed(orbRecord(sourceThreadId, projectId, "running", id)),
    kill: (id) => Effect.succeed(orbRecord(sourceThreadId, projectId, "killed", id)),
    forceKill: (id) => Effect.succeed(orbRecord(sourceThreadId, projectId, "killed", id)),
  }),
)

const fakeOrbMirrorLayer = Layer.succeed(
  OrbMirror.Service,
  OrbMirror.Service.of({
    mirror: () => Effect.void,
    flush: () => Effect.void,
    mirrorRunningOrbsOnce: () => Effect.void,
    syncRunning: () => Effect.void,
  }),
)

const orbRecord = (
  threadId: Ids.ThreadId,
  recordProjectId: Ids.ProjectId,
  status: Orb.OrbStatus,
  recordOrbId = orbId,
): Orb.OrbRecord => ({
  orb_id: recordOrbId,
  thread_id: threadId,
  project_id: recordProjectId,
  sandbox_id: "sandbox_cli_tournament_e2e",
  status,
  base_commit: "abc123",
  endpoint_url: "https://orb.cli-tournament-e2e.test",
  created_at: now,
  last_active_at: now,
})
