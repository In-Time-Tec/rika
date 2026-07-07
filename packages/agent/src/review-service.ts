import { ArtifactStore, Database } from "@rika/persistence"
import { Artifact, Common, Ids } from "@rika/schema"
import { Config, IdGenerator, Time } from "@rika/core"
import { ExtractJson } from "@rika/llm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as CheckRegistry from "./check-registry"
import * as SubagentRuntime from "./subagent-runtime"

export const ReviewStatus = Schema.Literals(["completed", "no_changes", "no_checks"]).annotate({
  identifier: "Rika.Agent.ReviewService.ReviewStatus",
})
export type ReviewStatus = typeof ReviewStatus.Type

export const ReviewRangeKind = Schema.Literals(["working-tree", "staged", "base"]).annotate({
  identifier: "Rika.Agent.ReviewService.ReviewRangeKind",
})
export type ReviewRangeKind = typeof ReviewRangeKind.Type

export interface ReviewInput extends Schema.Schema.Type<typeof ReviewInput> {}
export const ReviewInput = Schema.Struct({
  staged: Schema.optional(Schema.Boolean),
  base_ref: Schema.optional(Schema.String),
  paths: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Rika.Agent.ReviewService.ReviewInput" })

export interface ReviewRange extends Schema.Schema.Type<typeof ReviewRange> {}
export const ReviewRange = Schema.Struct({
  kind: ReviewRangeKind,
  base_ref: Schema.optional(Schema.String),
  paths: Schema.Array(Schema.String),
}).annotate({ identifier: "Rika.Agent.ReviewService.ReviewRange" })

export interface DiffSnapshot extends Schema.Schema.Type<typeof DiffSnapshot> {}
export const DiffSnapshot = Schema.Struct({
  range: ReviewRange,
  changed_files: Schema.Array(Schema.String),
  diff: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: "Rika.Agent.ReviewService.DiffSnapshot" })

export interface Finding extends Schema.Schema.Type<typeof Finding> {}
export const Finding = Schema.Struct({
  check_name: Schema.String,
  severity: CheckRegistry.Severity,
  path: Schema.String,
  range: Common.LineRange,
  title: Schema.String,
  evidence: Schema.String,
  recommendation: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Agent.ReviewService.Finding" })

export interface ReviewRun extends Schema.Schema.Type<typeof ReviewRun> {}
export const ReviewRun = Schema.Struct({
  review_id: Schema.String,
  thread_id: Ids.ThreadId,
  artifact_id: Ids.ArtifactId,
  status: ReviewStatus,
  range: ReviewRange,
  changed_files: Schema.Array(Schema.String),
  checks: Schema.Array(CheckRegistry.CheckSummary),
  findings: Schema.Array(Finding),
  started_at: Common.TimestampMillis,
  completed_at: Common.TimestampMillis,
}).annotate({ identifier: "Rika.Agent.ReviewService.ReviewRun" })

export interface ReviewResult extends Schema.Schema.Type<typeof ReviewResult> {}
export const ReviewResult = Schema.Struct({
  run: ReviewRun,
  artifact: Artifact.Artifact,
}).annotate({ identifier: "Rika.Agent.ReviewService.ReviewResult" })

export class ReviewServiceError extends Schema.TaggedErrorClass<ReviewServiceError>()("ReviewServiceError", {
  message: Schema.String,
  operation: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

export type RunError =
  | ReviewServiceError
  | CheckRegistry.CheckRegistryError
  | SubagentRuntime.RunError
  | ArtifactStore.ArtifactStoreError
  | Database.DatabaseError

export interface Interface {
  readonly run: (input?: ReviewInput) => Effect.Effect<ReviewResult, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/ReviewService") {}

export type DiffProvider = (
  input: ReviewInput,
  workspaceRoot: string,
) => Effect.Effect<DiffSnapshot, ReviewServiceError>

interface Dependencies {
  readonly artifactStore: ArtifactStore.Interface
  readonly checkRegistry: CheckRegistry.Interface
  readonly config: Config.Interface
  readonly idGenerator: IdGenerator.Interface
  readonly subagents: SubagentRuntime.Interface
  readonly time: Time.Interface
}

export const layerWithDiffProvider = (diffProvider: DiffProvider) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const artifactStore = yield* ArtifactStore.Service
      const checkRegistry = yield* CheckRegistry.Service
      const config = yield* Config.Service
      const idGenerator = yield* IdGenerator.Service
      const subagents = yield* SubagentRuntime.Service
      const time = yield* Time.Service
      const dependencies: Dependencies = { artifactStore, checkRegistry, config, idGenerator, subagents, time }

      return Service.of({
        run: Effect.fn("ReviewService.run")(function* (input: ReviewInput = {}) {
          return yield* runReview(dependencies, diffProvider, input)
        }),
      })
    }),
  )

export const fakeLayer = (handler: Interface["run"]) => Layer.succeed(Service, Service.of({ run: handler }))

export const run = Effect.fn("ReviewService.run.call")(function* (input: ReviewInput = {}) {
  const service = yield* Service
  return yield* service.run(input)
})

const runReview = (dependencies: Dependencies, diffProvider: DiffProvider, input: ReviewInput) =>
  Effect.gen(function* () {
    const config = yield* dependencies.config.get
    const startedAt = yield* dependencies.time.nowMillis
    const reviewId = yield* dependencies.idGenerator.next("review")
    const threadId = Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
    const artifactId = Ids.ArtifactId.make(yield* dependencies.idGenerator.next("artifact"))
    const diff = yield* diffProvider(input, config.workspace_root)
    const checks =
      diff.changed_files.length === 0
        ? []
        : yield* dependencies.checkRegistry.checksForFiles({ paths: diff.changed_files })
    const findings = checks.length === 0 ? [] : yield* runChecks(dependencies, checks, diff, threadId)
    const status: ReviewStatus =
      diff.changed_files.length === 0 ? "no_changes" : checks.length === 0 ? "no_checks" : "completed"
    const completedAt = yield* dependencies.time.nowMillis
    const reviewRun: ReviewRun = {
      review_id: reviewId,
      thread_id: threadId,
      artifact_id: artifactId,
      status,
      range: diff.range,
      changed_files: diff.changed_files,
      checks: checks.map((check) => check.summary),
      findings,
      started_at: startedAt,
      completed_at: completedAt,
    }
    const artifact: Artifact.Artifact = {
      id: artifactId,
      thread_id: threadId,
      workspace_id: Ids.WorkspaceId.make(config.workspace_root),
      kind: "review",
      title: `Review ${reviewId}`,
      content: reviewRunToJson(reviewRun),
      created_at: completedAt,
      metadata: { review_id: reviewId, status, changed_files: diff.changed_files.length, findings: findings.length },
    }
    const stored = yield* dependencies.artifactStore.put(artifact)
    return { run: reviewRun, artifact: stored }
  })

const runChecks = (
  dependencies: Dependencies,
  checks: ReadonlyArray<CheckRegistry.Check>,
  diff: DiffSnapshot,
  threadId: Ids.ThreadId,
) =>
  Effect.gen(function* () {
    const changedFiles = new Set(diff.changed_files)
    const findings: Array<Finding> = []
    for (const batch of chunks(checks, 4)) {
      const result = yield* dependencies.subagents.runBatch({
        parent_thread_id: threadId,
        agents: batch.map((check) => ({
          name: `review:${check.summary.name}`,
          prompt: checkPrompt(check, diff),
          tool_access: check.summary.tools.length === 0 ? "none" : "read-only",
          tool_names: check.summary.tools,
          max_output_chars: 6_000,
          profile: "review",
        })),
      })
      findings.push(
        ...result.runs.flatMap((subagentRun, index) => parseFindings(batch[index], subagentRun.summary, changedFiles)),
      )
    }
    return dedupeFindings(findings)
  })

const checkPrompt = (check: CheckRegistry.Check, diff: DiffSnapshot) =>
  [
    "Review the supplied local diff for exactly this check. Do not edit files.",
    `Check: ${check.summary.name}`,
    check.summary.description === undefined ? undefined : `Description: ${check.summary.description}`,
    `Default severity: ${check.summary.severity_default}`,
    `Applies to: ${check.summary.applies_to.length === 0 ? "all changed files" : check.summary.applies_to.join(", ")}`,
    "Instructions:",
    check.instructions,
    "Return JSON only with this shape:",
    `{"findings":[{"severity":"high","path":"src/file.ts","range":{"start_line":1,"end_line":1},"title":"short title","evidence":"specific evidence","recommendation":"smallest fix"}]}`,
    "Use an empty findings array when this check has no issue.",
    "Changed files:",
    diff.changed_files.map((path) => `- ${path}`).join("\n"),
    "Diff:",
    capDiff(diff.diff),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

const RawFindings = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({
      severity: Schema.optional(CheckRegistry.Severity),
      path: Schema.String,
      range: Common.LineRange,
      title: Schema.String,
      evidence: Schema.String,
      recommendation: Schema.optional(Schema.String),
    }),
  ),
})

const parseFindings = (
  check: CheckRegistry.Check | undefined,
  summary: string,
  changedFiles: ReadonlySet<string>,
): ReadonlyArray<Finding> => {
  if (check === undefined) return []
  const parsed = parseJson(summary)
  if (Option.isNone(parsed)) return []
  const decoded = Schema.decodeUnknownOption(RawFindings)(parsed.value)
  if (Option.isNone(decoded)) return []
  return decoded.value.findings.flatMap((finding) => {
    if (!changedFiles.has(finding.path)) return []
    return [
      {
        check_name: check.summary.name,
        severity: finding.severity ?? check.summary.severity_default,
        path: finding.path,
        range: finding.range,
        title: finding.title,
        evidence: finding.evidence,
        ...(finding.recommendation === undefined ? {} : { recommendation: finding.recommendation }),
      },
    ]
  })
}

const dedupeFindings = (findings: ReadonlyArray<Finding>) => {
  const byKey = new Map<string, Finding>()
  for (const finding of findings) {
    byKey.set(findingKey(finding), finding)
  }
  return [...byKey.values()].toSorted(
    (left, right) => left.path.localeCompare(right.path) || left.range.start_line - right.range.start_line,
  )
}

const findingKey = (finding: Finding) =>
  [
    finding.path,
    finding.range.start_line,
    finding.range.end_line,
    finding.check_name,
    finding.title.toLowerCase(),
  ].join(":")

const chunks = <A>(values: ReadonlyArray<A>, size: number) => {
  const result: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

const liveGitDiffProvider: DiffProvider = (input, workspaceRoot) =>
  Effect.gen(function* () {
    const range = reviewRange(input)
    const changedFiles = yield* runGit(workspaceRoot, nameOnlyArgs(input))
    const diff = yield* runGit(workspaceRoot, diffArgs(input))
    const capped = capDiff(diff)
    return {
      range,
      changed_files: changedFiles
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      diff: capped,
      truncated: capped.length < diff.length,
    } satisfies DiffSnapshot
  })

export const layer: Layer.Layer<
  Service,
  never,
  | ArtifactStore.Service
  | CheckRegistry.Service
  | Config.Service
  | IdGenerator.Service
  | SubagentRuntime.Service
  | Time.Service
> = layerWithDiffProvider(liveGitDiffProvider)

const reviewRange = (input: ReviewInput): ReviewRange => ({
  kind: input.base_ref === undefined ? (input.staged === true ? "staged" : "working-tree") : "base",
  ...(input.base_ref === undefined ? {} : { base_ref: input.base_ref }),
  paths: input.paths ?? [],
})

const nameOnlyArgs = (input: ReviewInput) => [
  ...diffBaseArgs(input),
  "--name-only",
  "--diff-filter=ACMRT",
  ...pathArgs(input),
]
const diffArgs = (input: ReviewInput) => [...diffBaseArgs(input), ...pathArgs(input)]

const diffBaseArgs = (input: ReviewInput) => {
  if (input.base_ref !== undefined) return ["diff", `${input.base_ref}...HEAD`]
  if (input.staged === true) return ["diff", "--cached"]
  return ["diff", "HEAD"]
}

const pathArgs = (input: ReviewInput) =>
  input.paths === undefined || input.paths.length === 0 ? [] : ["--", ...input.paths]

const runGit = (workspaceRoot: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(["git", ...args], { cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" })
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} exited with code ${exitCode}`)
      return stdout
    },
    catch: (cause) =>
      new ReviewServiceError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation: "gitDiff",
      }),
  })

const parseJson = (content: string): Option.Option<unknown> => {
  const json = ExtractJson.extractJson(content)
  try {
    return Option.some(JSON.parse(json))
  } catch {
    return Option.none()
  }
}

const capDiff = (diff: string) => (diff.length > 120_000 ? `${diff.slice(0, 120_000)}\n[diff truncated]` : diff)

const reviewRunToJson = (reviewRun: ReviewRun): Common.JsonValue => ({
  review_id: reviewRun.review_id,
  thread_id: reviewRun.thread_id,
  artifact_id: reviewRun.artifact_id,
  status: reviewRun.status,
  range: rangeToJson(reviewRun.range),
  changed_files: reviewRun.changed_files,
  checks: reviewRun.checks.map(checkSummaryToJson),
  findings: reviewRun.findings.map(findingToJson),
  started_at: reviewRun.started_at,
  completed_at: reviewRun.completed_at,
})

const rangeToJson = (range: ReviewRange): Common.JsonValue => ({
  kind: range.kind,
  ...(range.base_ref === undefined ? {} : { base_ref: range.base_ref }),
  paths: [...range.paths],
})

const checkSummaryToJson = (check: CheckRegistry.CheckSummary): Common.JsonValue => ({
  name: check.name,
  ...(check.description === undefined ? {} : { description: check.description }),
  severity_default: check.severity_default,
  tools: [...check.tools],
  source_path: check.source_path,
  scope_path: check.scope_path,
  applies_to: [...check.applies_to],
})

const findingToJson = (finding: Finding): Common.JsonValue => ({
  check_name: finding.check_name,
  severity: finding.severity,
  path: finding.path,
  range: { start_line: finding.range.start_line, end_line: finding.range.end_line },
  title: finding.title,
  evidence: finding.evidence,
  ...(finding.recommendation === undefined ? {} : { recommendation: finding.recommendation }),
})
