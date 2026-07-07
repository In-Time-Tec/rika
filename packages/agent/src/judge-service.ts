import { IdGenerator, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { ArtifactStore, Database } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"

export const ContentKind = Schema.Literals(["answer", "diff"]).annotate({
  identifier: "Rika.Agent.JudgeService.ContentKind",
})
export type ContentKind = typeof ContentKind.Type

export interface Candidate extends Schema.Schema.Type<typeof Candidate> {}
export const Candidate = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  content: Schema.String,
}).annotate({ identifier: "Rika.Agent.JudgeService.Candidate" })

export interface CompareInput extends Schema.Schema.Type<typeof CompareInput> {}
export const CompareInput = Schema.Struct({
  task: Schema.String,
  content_kind: ContentKind,
  candidates: Schema.Array(Candidate),
  rubric: Schema.optional(Schema.String),
  judges: Schema.optional(Schema.Int),
  thread_id: Ids.ThreadId,
  workspace_id: Schema.optional(Ids.WorkspaceId),
}).annotate({ identifier: "Rika.Agent.JudgeService.CompareInput" })

export const ScoreValue = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10)),
).annotate({ identifier: "Rika.Agent.JudgeService.ScoreValue" })
export type ScoreValue = typeof ScoreValue.Type

export interface JudgeScore extends Schema.Schema.Type<typeof JudgeScore> {}
export const JudgeScore = Schema.Struct({
  candidate_id: Schema.String,
  score: ScoreValue,
  strengths: Schema.String,
  weaknesses: Schema.String,
}).annotate({ identifier: "Rika.Agent.JudgeService.JudgeScore" })

export interface JudgeOutput extends Schema.Schema.Type<typeof JudgeOutput> {}
export const JudgeOutput = Schema.Struct({
  scores: Schema.Array(JudgeScore),
  winner_id: Schema.String,
  rationale: Schema.String,
}).annotate({ identifier: "Rika.Agent.JudgeService.JudgeOutput" })

export interface RankingEntry extends Schema.Schema.Type<typeof RankingEntry> {}
export const RankingEntry = Schema.Struct({
  candidate_id: Schema.String,
  median_score: Schema.Number,
  first_place_votes: Schema.Int,
}).annotate({ identifier: "Rika.Agent.JudgeService.RankingEntry" })

export interface Verdict extends Schema.Schema.Type<typeof Verdict> {}
export const Verdict = Schema.Struct({
  winner_id: Schema.String,
  ranking: Schema.Array(RankingEntry),
  judges: Schema.Array(JudgeOutput),
  rationale: Schema.String,
}).annotate({ identifier: "Rika.Agent.JudgeService.Verdict" })

export class JudgeError extends Schema.TaggedErrorClass<JudgeError>()("JudgeError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export type CompareError =
  | JudgeError
  | Router.RouterError
  | Router.StructuredOutputError
  | Provider.ProviderError
  | ArtifactStore.ArtifactStoreError
  | Database.DatabaseError

export interface Interface {
  readonly compare: (input: CompareInput) => Effect.Effect<Verdict, CompareError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/JudgeService") {}

interface Dependencies {
  readonly artifactStore: ArtifactStore.Interface
  readonly idGenerator: IdGenerator.Interface
  readonly router: Router.Interface
  readonly time: Time.Interface
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const artifactStore = yield* ArtifactStore.Service
    const idGenerator = yield* IdGenerator.Service
    const router = yield* Router.Service
    const time = yield* Time.Service
    const dependencies: Dependencies = { artifactStore, idGenerator, router, time }

    return Service.of({
      compare: Effect.fn("JudgeService.compare")(function* (input: CompareInput) {
        return yield* compareCandidates(dependencies, input)
      }),
    })
  }),
)

export const fakeLayer = (handler: Interface["compare"]) => Layer.succeed(Service, Service.of({ compare: handler }))

export const compare = Effect.fn("JudgeService.compare.call")(function* (input: CompareInput) {
  const service = yield* Service
  return yield* service.compare(input)
})

const compareCandidates = (dependencies: Dependencies, input: CompareInput) =>
  Effect.gen(function* () {
    const judgeCount = input.judges ?? 3
    yield* validateInput(input, judgeCount)
    const judges: Array<JudgeOutput> = []
    for (let index = 0; index < judgeCount; index += 1) {
      const response = yield* dependencies.router.completeStructured({
        profile: "oracle",
        messages: judgeMessages(input, rotate(input.candidates, index), index + 1, judgeCount),
        schema: JudgeOutput,
        objectName: "judge_verdict",
      })
      judges.push(yield* validateJudgeOutput(input, response.value, index + 1))
    }
    const verdict = aggregate(input, judges)
    const artifactId = Ids.ArtifactId.make(yield* dependencies.idGenerator.next("artifact"))
    const createdAt = yield* dependencies.time.nowMillis
    yield* dependencies.artifactStore.put({
      id: artifactId,
      thread_id: input.thread_id,
      ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
      kind: "verdict",
      title: "Judge verdict",
      content: verdictToJson(verdict),
      created_at: createdAt,
      metadata: {
        winner_id: verdict.winner_id,
        candidate_count: input.candidates.length,
        judge_count: judgeCount,
      },
    })
    return verdict
  })

const validateInput = (input: CompareInput, judgeCount: number) =>
  Effect.gen(function* () {
    if (input.candidates.length < 2 || input.candidates.length > 8) {
      return yield* new JudgeError({
        message: "JudgeService requires between 2 and 8 candidates",
        operation: "validate",
      })
    }
    if (!Number.isInteger(judgeCount) || judgeCount < 1) {
      return yield* new JudgeError({
        message: "JudgeService requires at least one judge",
        operation: "validate",
      })
    }
    const candidateIds = new Set(input.candidates.map((candidate) => candidate.id))
    if (candidateIds.size !== input.candidates.length) {
      return yield* new JudgeError({
        message: "JudgeService requires unique candidate ids",
        operation: "validate",
      })
    }
    return undefined
  })

const validateJudgeOutput = (input: CompareInput, output: JudgeOutput, judgeNumber: number) =>
  Effect.gen(function* () {
    const candidateIds = new Set(input.candidates.map((candidate) => candidate.id))
    if (!candidateIds.has(output.winner_id)) {
      return yield* new JudgeError({
        message: `Judge ${judgeNumber} returned an unknown winner id`,
        operation: "judgeOutput",
      })
    }
    const scoreIds = new Set(output.scores.map((score) => score.candidate_id))
    if (
      output.scores.length !== input.candidates.length ||
      scoreIds.size !== input.candidates.length ||
      [...candidateIds].some((candidateId) => !scoreIds.has(candidateId))
    ) {
      return yield* new JudgeError({
        message: `Judge ${judgeNumber} did not score every candidate exactly once`,
        operation: "judgeOutput",
      })
    }
    return output
  })

const judgeMessages = (
  input: CompareInput,
  candidates: ReadonlyArray<Candidate>,
  judgeNumber: number,
  judgeCount: number,
): ReadonlyArray<Provider.Message> => [
  {
    role: "system",
    content:
      "You are a strict comparative judge. Score only from supplied evidence, do not invent facts, and return structured JSON only.",
  },
  {
    role: "user",
    content: judgePrompt(input, candidates, judgeNumber, judgeCount),
  },
]

const judgePrompt = (
  input: CompareInput,
  candidates: ReadonlyArray<Candidate>,
  judgeNumber: number,
  judgeCount: number,
) =>
  [
    `Judge ${judgeNumber} of ${judgeCount}.`,
    `Task: ${input.task}`,
    `Content kind: ${input.content_kind}`,
    "Judge every candidate independently before choosing a winner.",
    "Penalize candidates that do not address the task, fabricate claims, or make unrelated changes.",
    input.content_kind === "diff"
      ? "For diffs, penalize missing tests, unsafe scope, and claims unsupported by the diff."
      : undefined,
    input.rubric === undefined ? undefined : `Additional rubric:\n${input.rubric}`,
    "Candidates:",
    candidates.map(candidatePrompt).join("\n\n"),
    "Return one score for every candidate_id, using integer scores from 0 to 10.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

const candidatePrompt = (candidate: Candidate) =>
  [`Candidate ${candidate.id} (${candidate.label})`, "Content:", candidate.content].join("\n")

const aggregate = (input: CompareInput, judges: ReadonlyArray<JudgeOutput>): Verdict => {
  const candidateIndexes = new Map(input.candidates.map((candidate, index) => [candidate.id, index]))
  const firstPlaceVotes = new Map(input.candidates.map((candidate) => [candidate.id, 0]))
  for (const judge of judges) {
    firstPlaceVotes.set(judge.winner_id, (firstPlaceVotes.get(judge.winner_id) ?? 0) + 1)
  }
  const ranking = input.candidates
    .map(
      (candidate): RankingEntry => ({
        candidate_id: candidate.id,
        median_score: median(judges.map((judge) => scoreFor(judge, candidate.id))),
        first_place_votes: firstPlaceVotes.get(candidate.id) ?? 0,
      }),
    )
    .toSorted(
      (left, right) =>
        right.median_score - left.median_score ||
        right.first_place_votes - left.first_place_votes ||
        (candidateIndexes.get(left.candidate_id) ?? 0) - (candidateIndexes.get(right.candidate_id) ?? 0),
    )
  const winnerId = ranking[0]?.candidate_id ?? input.candidates[0]?.id ?? ""
  return {
    winner_id: winnerId,
    ranking,
    judges: [...judges],
    rationale: majorityStrengths(judges, winnerId),
  }
}

const scoreFor = (judge: JudgeOutput, candidateId: string) =>
  judge.scores.find((score) => score.candidate_id === candidateId)?.score ?? 0

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0)
}

const majorityStrengths = (judges: ReadonlyArray<JudgeOutput>, winnerId: string) =>
  judges
    .filter((judge) => judge.winner_id === winnerId)
    .flatMap((judge) => judge.scores.filter((score) => score.candidate_id === winnerId))
    .map((score) => score.strengths.trim())
    .filter((strength) => strength.length > 0)
    .join("\n")

const rotate = <A>(values: ReadonlyArray<A>, offset: number): ReadonlyArray<A> => {
  const normalized = values.length === 0 ? 0 : offset % values.length
  return [...values.slice(normalized), ...values.slice(0, normalized)]
}

const verdictToJson = (verdict: Verdict): Common.JsonValue => ({
  winner_id: verdict.winner_id,
  ranking: verdict.ranking.map((entry) => ({
    candidate_id: entry.candidate_id,
    median_score: entry.median_score,
    first_place_votes: entry.first_place_votes,
  })),
  judges: verdict.judges.map((judge) => ({
    winner_id: judge.winner_id,
    rationale: judge.rationale,
    scores: judge.scores.map((score) => ({
      candidate_id: score.candidate_id,
      score: score.score,
      strengths: score.strengths,
      weaknesses: score.weaknesses,
    })),
  })),
  rationale: verdict.rationale,
})
