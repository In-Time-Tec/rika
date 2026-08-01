import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Console, Effect, Exit, FileSystem, Function, Layer, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import {
  evaluateMetric,
  metricPolicy,
  type MetricEvaluation,
  type PerformanceMetricPolicy,
} from "./performance-metric-policy"

export interface PerformanceMetricSample {
  readonly id: string
  readonly unit: string
  readonly value?: number
  readonly status: "measured" | "unsupported"
  readonly target?: { readonly operator: string; readonly value: number }
}

export interface PerformanceEvidence {
  readonly schemaVersion: number
  readonly evidence: Readonly<Record<string, unknown>>
  readonly workload: Readonly<Record<string, unknown>>
  readonly process: Readonly<Record<string, unknown>>
  readonly metrics: ReadonlyArray<PerformanceMetricSample>
}

export interface ComparisonResult {
  readonly pass: boolean
  readonly failures: ReadonlyArray<string>
  readonly metrics: ReadonlyArray<MetricEvaluation>
  readonly unsupported: ReadonlyArray<string>
}

const stableEvidence = (run: PerformanceEvidence) => ({
  schemaVersion: run.schemaVersion,
  workload: run.workload,
  terminal: run.evidence.terminal,
  processSamples: run.evidence.processSamples,
  process: run.process,
})

const encoded = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(encoded).join(",")}]`
  if (typeof value !== "object" || value === null) return JSON.stringify(value)
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${encoded(nested)}`)
    .join(",")}}`
}

const compatible = (left: PerformanceEvidence, right: PerformanceEvidence): boolean =>
  encoded(stableEvidence(left)) === encoded(stableEvidence(right)) &&
  left.metrics
    .map(({ id }) => id)
    .toSorted()
    .join("\n") ===
    right.metrics
      .map(({ id }) => id)
      .toSorted()
      .join("\n")

const median = (values: ReadonlyArray<number>): number => {
  const sorted = values.toSorted((left, right) => left - right)
  if (sorted.length === 0) return Number.NaN
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

const metricValues = (runs: ReadonlyArray<PerformanceEvidence>, id: string): ReadonlyArray<number> =>
  runs.flatMap((run) => {
    const metric = run.metrics.find((candidate) => candidate.id === id)
    return metric?.status === "measured" && metric.value !== undefined ? [metric.value] : []
  })

const metricStatus = (runs: ReadonlyArray<PerformanceEvidence>, id: string): "measured" | "unsupported" =>
  runs.every((run) => run.metrics.find((metric) => metric.id === id)?.status === "unsupported")
    ? "unsupported"
    : "measured"

const comparisonFailure = (message: string): ComparisonResult => ({
  pass: false,
  failures: [message],
  metrics: [],
  unsupported: [],
})

const comparePolicyMetric = (
  policy: PerformanceMetricPolicy,
  baseline: ReadonlyArray<PerformanceEvidence>,
  candidate: ReadonlyArray<PerformanceEvidence>,
): MetricEvaluation | undefined => {
  const baselineValues = metricValues(baseline, policy.id)
  const candidateValues = metricValues(candidate, policy.id)
  if (baselineValues.length === 0 || candidateValues.length === 0) return undefined
  return evaluateMetric(policy, median(baselineValues), median(candidateValues))
}

const comparePerformanceRunsImpl = (
  baseline: ReadonlyArray<PerformanceEvidence>,
  candidate: ReadonlyArray<PerformanceEvidence>,
): ComparisonResult => {
  if (baseline.length !== 3 || candidate.length !== 3)
    return comparisonFailure("comparison requires three baseline and candidate runs")
  if (!baseline.every((run) => compatible(baseline[0]!, run)))
    return comparisonFailure("baseline workloads are incompatible")
  if (!candidate.every((run) => compatible(candidate[0]!, run)))
    return comparisonFailure("candidate workloads are incompatible")
  if (!compatible(baseline[0]!, candidate[0]!))
    return comparisonFailure("baseline and candidate workloads are incompatible")

  const ids = baseline[0]!.metrics.map(({ id }) => id).toSorted()
  const unsupported: Array<string> = []
  const metrics: Array<MetricEvaluation> = []
  const failures: Array<string> = []
  for (const id of ids) {
    const baselineState = metricStatus(baseline, id)
    const candidateState = metricStatus(candidate, id)
    if (baselineState === "unsupported") {
      if (candidateState === "unsupported") unsupported.push(id)
      continue
    }
    if (candidateState === "unsupported") {
      failures.push(`${id}: metric became unsupported`)
      continue
    }
    const policy = metricPolicy(id)
    if (policy === undefined) continue
    const evaluation = comparePolicyMetric(policy, baseline, candidate)
    if (evaluation === undefined) {
      failures.push(`${id}: metric is missing a measured value`)
      continue
    }
    metrics.push(evaluation)
    if (!evaluation.pass) failures.push(`${id}: candidate failed target or baseline tolerance`)
  }
  return { pass: failures.length === 0, failures, metrics, unsupported }
}

export const comparePerformanceRuns: {
  (candidate: ReadonlyArray<PerformanceEvidence>): (baseline: ReadonlyArray<PerformanceEvidence>) => ComparisonResult
  (baseline: ReadonlyArray<PerformanceEvidence>, candidate: ReadonlyArray<PerformanceEvidence>): ComparisonResult
} = Function.dual(2, comparePerformanceRunsImpl)

const PerformanceMetricSampleSchema = Schema.Struct({
  id: Schema.String,
  unit: Schema.String,
  value: Schema.optional(Schema.Finite),
  status: Schema.Literals(["measured", "unsupported"]),
  target: Schema.optional(Schema.Struct({ operator: Schema.String, value: Schema.Finite })),
})
const PerformanceEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Finite,
  evidence: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  workload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  process: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  metrics: Schema.Array(PerformanceMetricSampleSchema),
})
const EvidenceJson = Schema.fromJsonString(PerformanceEvidenceSchema)
class EvidenceReadError extends Schema.TaggedErrorClass<EvidenceReadError>()("EvidenceReadError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const loadEvidence = (path: string): Effect.Effect<PerformanceEvidence, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const text = yield* fileSystem
      .readFileString(path)
      .pipe(Effect.mapError((error) => EvidenceReadError.make({ path, message: String(error) })))
    const decoded = Schema.decodeUnknownExit(EvidenceJson)(text)
    if (Exit.isFailure(decoded)) return yield* Effect.die(Cause.pretty(decoded.cause))
    return decoded.value
  }).pipe(Effect.orDie)

const command = Command.make(
  "performance-comparison",
  {
    baseline: Flag.between(Flag.file("baseline", { mustExist: true }), 3, 3),
    candidate: Flag.between(Flag.file("candidate", { mustExist: true }), 3, 3),
  },
  ({ baseline, candidate }) =>
    Effect.gen(function* () {
      const baselineRuns = yield* Effect.forEach(baseline, loadEvidence)
      const candidateRuns = yield* Effect.forEach(candidate, loadEvidence)
      const result = comparePerformanceRuns(baselineRuns, candidateRuns)
      yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result))
      if (!result.pass) return yield* Effect.die(result.failures.join("\n"))
    }),
)

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer.pipe(Layer.orDie)), (context) =>
        Effect.provide(Command.run(command, { version: "0.0.0" }).pipe(Effect.orDie), context),
      ),
    ),
  )
