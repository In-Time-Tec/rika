import { JudgeService } from "@rika/agent"
import { Config, IdGenerator, Settings, Time } from "@rika/core"
import { OrbManager } from "@rika/orb"
import { ArtifactStore, Database, OrbStore, ProjectStore } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Event, Ids, Message, Orb, Remote } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Args from "./args"
import * as Output from "./output"
import * as Project from "./project"
import * as Sync from "./sync"

const maxDiffChars = 120_000

export class OrbTournamentError extends Schema.TaggedErrorClass<OrbTournamentError>()("OrbTournamentError", {
  message: Schema.String,
  exit_code: Schema.Int,
}) {}

export type RunError =
  | Client.SdkError
  | ArtifactStore.ArtifactStoreError
  | Database.DatabaseError
  | JudgeService.CompareError
  | OrbManager.OrbProvisionError
  | OrbStore.OrbStoreError
  | OrbTournamentError
  | Project.ProjectError
  | ProjectStore.ProjectStoreError
  | Settings.SettingsError
  | Sync.RunError

export type ClientFactory = (endpointUrl: string, token: string) => Client.Interface

export interface Interface {
  readonly executeCommand: (command: Args.OrbCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/OrbTournament") {}

interface CandidateOutcome {
  readonly index: number
  readonly thread_id: Ids.ThreadId
  readonly workspace_id?: Ids.WorkspaceId
  readonly orb_id?: Ids.OrbId
  readonly mode: Config.Mode
  readonly status: "completed" | "failed"
  readonly candidate_id?: string
  readonly content?: string
  readonly changes?: Remote.OrbChangesResponse
  readonly changed_files?: number
  readonly error?: string
}

interface CompletedCandidate extends CandidateOutcome {
  readonly orb_id: Ids.OrbId
  readonly workspace_id: Ids.WorkspaceId
  readonly status: "completed"
  readonly candidate_id: string
  readonly content: string
  readonly changes: Remote.OrbChangesResponse
  readonly changed_files: number
}

export const layerWithClientFactory = (clientFactory: ClientFactory) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const output = yield* Output.Service
      const config = yield* Config.Service
      const values = yield* config.get
      const settings = Option.getOrUndefined(yield* Effect.serviceOption(Settings.Service))
      const idGenerator = yield* IdGenerator.Service
      const time = yield* Time.Service
      const projects = yield* ProjectStore.Service
      const orbs = yield* OrbStore.Service
      const artifacts = yield* ArtifactStore.Service
      const manager = yield* OrbManager.Service
      const judge = yield* JudgeService.Service
      const sync = Option.getOrUndefined(yield* Effect.serviceOption(Sync.Service))

      return Service.of({
        executeCommand: Effect.fn("Cli.OrbTournament.executeCommand")(function* (command: Args.OrbCommand) {
          const input = yield* normalizeInput(command, values.default_mode)
          const project = yield* resolveProject(projects, input.projectName, values.workspace_root, settings)
          const outcomes = yield* Effect.forEach(
            Array.from({ length: input.branchCount }, (_, index) => index),
            (index) =>
              runCandidate({
                index,
                input,
                project,
                workspaceRoot: values.workspace_root,
                idGenerator,
                manager,
                orbs,
                clientFactory,
                output,
              }),
            { concurrency: "unbounded" },
          )
          const survivors = outcomes.filter(isCompleted)
          if (survivors.length < 2) {
            yield* output.stdout("Orb tournament requires at least two completed diffs")
            yield* Effect.forEach(outcomes, (outcome) => output.stdout(formatOutcome(outcome)), { discard: true })
            yield* cleanupLosers(artifacts, idGenerator, time, manager, outcomes, undefined, input.keepLosers)
            return 1
          }
          const firstSurvivor = survivors[0]
          if (firstSurvivor === undefined) {
            return yield* new OrbTournamentError({
              message: "Orb tournament produced no surviving diffs",
              exit_code: 1,
            })
          }
          const judged = yield* Effect.result(
            runJudgedPhase({
              input,
              survivors,
              judge,
              sync,
            }),
          )
          if (judged._tag === "Failure") {
            yield* cleanupLosers(artifacts, idGenerator, time, manager, outcomes, undefined, input.keepLosers)
            return yield* Effect.fail(judged.failure)
          }
          const winner = judged.success.winner
          const completed = yield* Effect.result(
            Effect.gen(function* () {
              yield* storeWinnerVerdict(
                artifacts,
                idGenerator,
                time,
                winner.thread_id,
                winner.workspace_id,
                judged.success.verdict,
                survivors.length,
              )
              yield* output.stdout("Rank\tThread\tMode\tScore\tChanged Files\tStrengths")
              yield* Effect.forEach(judged.success.ranking, (row) => output.stdout(formatRankingRow(row)), {
                discard: true,
              })
              yield* cleanupLosers(artifacts, idGenerator, time, manager, outcomes, winner.orb_id, input.keepLosers)
            }),
          )
          if (completed._tag === "Failure") {
            yield* cleanupLosers(artifacts, idGenerator, time, manager, outcomes, winner.orb_id, input.keepLosers)
            return yield* Effect.fail(completed.failure)
          }
          if (input.syncWinner) {
            const syncExitCode = yield* syncWinnerThread(sync, winner.thread_id)
            if (syncExitCode !== 0) return syncExitCode
          }
          return 0
        }),
      })
    }),
  )

export const layer = layerWithClientFactory((endpointUrl, token) =>
  Client.make(Client.fetchTransport({ base_url: endpointUrl, token })),
)

export const executeCommand = Effect.fn("Cli.OrbTournament.executeCommand.call")(function* (command: Args.OrbCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: Args.ArgsError | RunError) => {
  if (error instanceof Args.ArgsError && error.usage !== undefined) return `${error.message}\n${error.usage}`
  if (error instanceof Args.ArgsError || error instanceof OrbTournamentError) return error.message
  if (error instanceof Client.SdkError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const normalizeInput = (command: Args.OrbCommand, defaultMode: Config.Mode) =>
  Effect.gen(function* () {
    if (command.action !== "tournament") {
      return yield* new OrbTournamentError({ message: "Expected orb tournament command", exit_code: 2 })
    }
    const task = command.task?.trim() ?? ""
    if (task.length === 0) {
      return yield* new OrbTournamentError({ message: "Orb tournament task is required", exit_code: 2 })
    }
    const branchCount = command.branch_count
    if (branchCount === undefined || !Number.isInteger(branchCount) || branchCount < 2 || branchCount > 4) {
      return yield* new OrbTournamentError({
        message: "Orb tournament branch count must be between 2 and 4",
        exit_code: 2,
      })
    }
    if (command.modes !== undefined && command.modes.length !== branchCount) {
      return yield* new OrbTournamentError({
        message: "Orb tournament modes count must equal branch count",
        exit_code: 2,
      })
    }
    return {
      task,
      branchCount,
      modes: command.modes ?? Array.from({ length: branchCount }, () => defaultMode),
      projectName: command.project_name,
      rubric: command.rubric,
      syncWinner: command.sync_winner === true,
      keepLosers: command.keep_losers === true,
    }
  })

const resolveProject = Effect.fn("Cli.OrbTournament.resolveProject")(function* (
  projects: ProjectStore.Interface,
  projectName: string | undefined,
  workspaceRoot: string,
  settings: Settings.Interface | undefined,
) {
  if (projectName !== undefined) {
    const project = yield* projects.getByName(projectName)
    if (project !== undefined) return project
    return yield* new OrbTournamentError({ message: `Project ${projectName} not found`, exit_code: 2 })
  }
  if (settings !== undefined) {
    const snapshot = yield* settings.snapshot
    const configuredDefault = snapshot.values.project.default
    if (configuredDefault !== undefined) {
      const project = yield* projects.getByName(configuredDefault)
      if (project !== undefined) return project
      return yield* new OrbTournamentError({ message: `Project ${configuredDefault} not found`, exit_code: 2 })
    }
  }
  const origin = yield* Project.currentGitRemoteOrigin(workspaceRoot).pipe(Effect.option)
  if (Option.isSome(origin)) {
    const project = yield* projects.getByRepoOrigin(origin.value)
    if (project !== undefined) return project
  }
  return yield* new OrbTournamentError({
    message: "no project for this repo; run: rika project create <name> --repo <origin>",
    exit_code: 2,
  })
})

const runJudgedPhase = Effect.fn("Cli.OrbTournament.runJudgedPhase")(function* (input: {
  readonly input: {
    readonly task: string
    readonly rubric: string | undefined
    readonly syncWinner: boolean
  }
  readonly survivors: ReadonlyArray<CompletedCandidate>
  readonly judge: JudgeService.Interface
  readonly sync: Sync.Interface | undefined
}) {
  const firstSurvivor = input.survivors[0]
  if (firstSurvivor === undefined) {
    return yield* new OrbTournamentError({
      message: "Orb tournament produced no surviving diffs",
      exit_code: 1,
    })
  }
  const syncService = input.sync
  if (input.input.syncWinner && syncService === undefined) {
    return yield* new OrbTournamentError({ message: "Sync service is unavailable", exit_code: 1 })
  }
  const verdict = yield* input.judge.compare({
    task: input.input.task,
    content_kind: "diff",
    candidates: input.survivors.map((candidate) => ({
      id: candidate.candidate_id,
      label: `orb ${candidate.index} (${candidate.mode})`,
      content: candidate.content,
    })),
    ...(input.input.rubric === undefined ? {} : { rubric: input.input.rubric }),
    thread_id: firstSurvivor.thread_id,
    workspace_id: firstSurvivor.workspace_id,
  })
  const ranking = rankingRows(verdict, input.survivors)
  const winner = input.survivors.find((candidate) => candidate.candidate_id === verdict.winner_id) ?? firstSurvivor
  return { verdict, ranking, winner }
})

const syncWinnerThread = (
  sync: Sync.Interface | undefined,
  threadId: Ids.ThreadId,
): Effect.Effect<number, Sync.RunError | OrbTournamentError> => {
  if (sync === undefined) {
    return Effect.fail(new OrbTournamentError({ message: "Sync service is unavailable", exit_code: 1 }))
  }
  return sync.executeCommand({ type: "sync", thread_id: threadId })
}

const runCandidate = (input: {
  readonly index: number
  readonly input: {
    readonly task: string
    readonly branchCount: number
    readonly modes: ReadonlyArray<Config.Mode>
  }
  readonly project: Orb.ProjectRecord
  readonly workspaceRoot: string
  readonly idGenerator: IdGenerator.Interface
  readonly manager: OrbManager.Interface
  readonly orbs: OrbStore.Interface
  readonly clientFactory: ClientFactory
  readonly output: Output.Interface
}): Effect.Effect<CandidateOutcome, RunError> =>
  Effect.gen(function* () {
    const ordinal = input.index + 1
    const threadId = Ids.ThreadId.make(yield* input.idGenerator.next("thread"))
    const mode = input.input.modes[input.index] ?? input.input.modes[0] ?? "smart"
    const provision = yield* Effect.result(
      input.manager.provisionForThread({
        thread_id: threadId,
        project_id: input.project.project_id,
        workspace_root: input.workspaceRoot,
      }),
    )
    if (provision._tag === "Failure") {
      return failedOutcome(ordinal, threadId, provision.failure.orb_id, mode, failureMessage(provision.failure))
    }
    const orb = provision.success
    return yield* runProvisionedCandidate({ ...input, ordinal, threadId, mode, orb }).pipe(
      Effect.catch((error: RunError) =>
        Effect.succeed(failedOutcome(ordinal, threadId, orb.orb_id, mode, failureMessage(error))),
      ),
    )
  })

const runProvisionedCandidate = (input: {
  readonly ordinal: number
  readonly threadId: Ids.ThreadId
  readonly mode: Config.Mode
  readonly orb: Orb.OrbRecord
  readonly input: {
    readonly task: string
    readonly branchCount: number
  }
  readonly project: Orb.ProjectRecord
  readonly orbs: OrbStore.Interface
  readonly clientFactory: ClientFactory
  readonly output: Output.Interface
}): Effect.Effect<CandidateOutcome, RunError> =>
  Effect.gen(function* () {
    const endpoint = yield* input.orbs.endpointCredentials(input.orb.orb_id)
    if (endpoint === undefined) {
      return failedOutcome(
        input.ordinal,
        input.threadId,
        input.orb.orb_id,
        input.mode,
        `Orb ${input.orb.orb_id} has no endpoint`,
      )
    }
    const client = input.clientFactory(endpoint.endpoint_url, endpoint.token)
    const thread = yield* client.createThread({ thread_id: input.threadId, project_id: input.project.project_id })
    yield* input.output.stderr(`[orb ${input.ordinal}/${input.input.branchCount}] turn running...`)
    const start = yield* Effect.result(
      client.startTurn({
        thread_id: input.threadId,
        project_id: input.project.project_id,
        content: input.input.task,
        mode: input.mode,
      }),
    )
    if (start._tag === "Failure") {
      return failedOutcome(input.ordinal, input.threadId, input.orb.orb_id, input.mode, failureMessage(start.failure))
    }
    const events = yield* client.subscribeThreadEvents({ thread_id: input.threadId }).pipe(
      Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    )
    const terminal = events.find((event) => event.type === "turn.completed" || event.type === "turn.failed")
    if (terminal === undefined) {
      return failedOutcome(
        input.ordinal,
        input.threadId,
        input.orb.orb_id,
        input.mode,
        "Orb event stream ended before turn completed",
      )
    }
    if (terminal.type === "turn.failed") {
      return failedOutcome(
        input.ordinal,
        input.threadId,
        input.orb.orb_id,
        input.mode,
        terminal.data.error.message ?? terminal.data.error.kind,
      )
    }
    const changes = yield* client.orbChanges()
    const diff = changes.diff.trim()
    if (diff.length === 0) {
      return failedOutcome(input.ordinal, input.threadId, input.orb.orb_id, input.mode, "Orb completed without a diff")
    }
    const summary = assistantSummary(events)
    return {
      index: input.ordinal,
      thread_id: input.threadId,
      workspace_id: thread.workspace_id,
      orb_id: input.orb.orb_id,
      mode: input.mode,
      status: "completed",
      candidate_id: `orb-${input.ordinal}`,
      content: candidateContent(diff, summary),
      changes,
      changed_files: changedFileCount(diff),
    }
  })

const failedOutcome = (
  index: number,
  threadId: Ids.ThreadId,
  orbId: Ids.OrbId | undefined,
  mode: Config.Mode,
  error: string,
): CandidateOutcome => ({
  index,
  thread_id: threadId,
  ...(orbId === undefined ? {} : { orb_id: orbId }),
  mode,
  status: "failed",
  error,
})

const isCompleted = (outcome: CandidateOutcome): outcome is CompletedCandidate =>
  outcome.status === "completed" &&
  outcome.orb_id !== undefined &&
  outcome.candidate_id !== undefined &&
  outcome.content !== undefined &&
  outcome.changes !== undefined &&
  outcome.changed_files !== undefined

const assistantSummary = (events: ReadonlyArray<Event.Event>) => {
  const message = events
    .toReversed()
    .find(
      (event): event is Event.MessageAdded => event.type === "message.added" && event.data.message.role === "assistant",
    )
  if (message === undefined) return ""
  return Message.displayText(message.data.message).trim()
}

const candidateContent = (diff: string, summary: string) =>
  [capDiff(diff), summary.length === 0 ? undefined : `## Candidate summary\n${summary}`]
    .filter((part): part is string => part !== undefined)
    .join("\n\n")

const capDiff = (diff: string) =>
  diff.length <= maxDiffChars ? diff : `${diff.slice(0, maxDiffChars)}\n\n[diff truncated at ${maxDiffChars} chars]`

const changedFileCount = (diff: string) => {
  const matches = diff.match(/^diff --git /gm)
  return matches?.length ?? 0
}

const rankingRows = (verdict: JudgeService.Verdict, outcomes: ReadonlyArray<CompletedCandidate>) =>
  verdict.ranking.flatMap((entry, index) => {
    const outcome = outcomes.find((candidate) => candidate.candidate_id === entry.candidate_id)
    if (outcome === undefined) return []
    return [
      {
        rank: index + 1,
        thread_id: outcome.thread_id,
        mode: outcome.mode,
        median_score: entry.median_score,
        changed_files: outcome.changed_files,
        strengths: strengthsFor(verdict, entry.candidate_id),
      },
    ]
  })

const formatRankingRow = (row: ReturnType<typeof rankingRows>[number]) =>
  `${row.rank}\t${row.thread_id}\t${row.mode}\t${row.median_score}\t${row.changed_files}\t${row.strengths}`

const formatOutcome = (outcome: CandidateOutcome) =>
  `${outcome.index}\t${outcome.thread_id}\t${outcome.mode}\t${outcome.status}\t${outcome.error ?? ""}`

const strengthsFor = (verdict: JudgeService.Verdict, candidateId: string) =>
  verdict.judges
    .flatMap((judge) => judge.scores)
    .find((score) => score.candidate_id === candidateId && score.strengths.trim().length > 0)
    ?.strengths.trim() ?? ""

const hasKnownOrb = (outcome: CandidateOutcome): outcome is CandidateOutcome & { readonly orb_id: Ids.OrbId } =>
  outcome.orb_id !== undefined

const cleanupLosers = (
  artifacts: ArtifactStore.Interface,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
  manager: OrbManager.Interface,
  outcomes: ReadonlyArray<CandidateOutcome>,
  winnerOrbId: Ids.OrbId | undefined,
  keepLosers: boolean,
) =>
  Effect.forEach(
    outcomes.filter(hasKnownOrb).filter((outcome) => outcome.orb_id !== winnerOrbId),
    (outcome) =>
      keepLosers
        ? manager.pause(outcome.orb_id)
        : Effect.gen(function* () {
            if (isCompleted(outcome)) {
              yield* storeFinalDiff(
                artifacts,
                idGenerator,
                time,
                outcome.thread_id,
                outcome.workspace_id,
                outcome.changes,
              )
            }
            return yield* manager.kill(outcome.orb_id)
          }),
    { discard: true },
  )

const storeFinalDiff = (
  artifacts: ArtifactStore.Interface,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
  threadId: Ids.ThreadId,
  workspaceId: Ids.WorkspaceId,
  changes: Remote.OrbChangesResponse,
) =>
  Effect.gen(function* () {
    const artifactId = Ids.ArtifactId.make(yield* idGenerator.next("artifact"))
    const createdAt = yield* time.nowMillis
    yield* artifacts.put({
      id: artifactId,
      thread_id: threadId,
      workspace_id: workspaceId,
      kind: "orb-final-diff",
      title: "Orb final diff",
      content: changes,
      created_at: createdAt,
    })
  })

const storeWinnerVerdict = (
  artifacts: ArtifactStore.Interface,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
  threadId: Ids.ThreadId,
  workspaceId: Ids.WorkspaceId,
  verdict: JudgeService.Verdict,
  candidateCount: number,
) =>
  Effect.gen(function* () {
    const artifactId = Ids.ArtifactId.make(yield* idGenerator.next("artifact"))
    const createdAt = yield* time.nowMillis
    yield* artifacts.put({
      id: artifactId,
      thread_id: threadId,
      workspace_id: workspaceId,
      kind: "verdict",
      title: "Orb tournament verdict",
      content: verdict,
      created_at: createdAt,
      metadata: {
        winner_id: verdict.winner_id,
        candidate_count: candidateCount,
        judge_count: verdict.judges.length,
      },
    })
  })

const failureMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
