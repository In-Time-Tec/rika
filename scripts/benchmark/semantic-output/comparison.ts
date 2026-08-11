import { median } from "../benchmark-statistics"
import type { Aggregate, Case, Comparison, Sample } from "./contract"
import { cases } from "./contract"
import { outputBytes, outputSha256 } from "./workload"

const paths = [
  "timing.wallMilliseconds",
  "timing.cpuMilliseconds",
  "timing.firstPreviewMilliseconds",
  "timing.controlAckMilliseconds",
  "timing.completionMilliseconds",
  "memory.peakHeapBytes",
  "memory.postGcHeapBytes",
  "memory.peakProcessTreeRssBytes",
  "memory.postGcProcessTreeRssBytes",
  "batonSql.totalEvents",
  "batonSql.eventJsonBytes",
  "batonSql.operationResultBytes",
  "projection.commitProjectionCalls",
] as const

const atPath = (sample: Sample, path: string): unknown => {
  let value: unknown = sample
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

export const aggregate = (samples: ReadonlyArray<Sample>): Aggregate => {
  if (samples.length === 0) throw new Error("cannot aggregate an empty sample set")
  const first = samples[0]!
  const compatible = samples.every(
    (sample) =>
      !sample.warmup && sample.source === first.source && sample.mode === first.mode && sample.case === first.case,
  )
  if (!compatible) throw new Error("samples must be measured runs for one source, mode, and case")
  const values = Object.fromEntries(
    paths.flatMap((path) => {
      const measured = samples.map((sample) => atPath(sample, path))
      if (!measured.every((value): value is number => typeof value === "number")) return []
      return [[path, median(measured)] as const]
    }),
  )
  return { source: first.source, mode: first.mode, case: first.case, samples, median: values }
}

const ratio = (candidate: number, baseline: number): number => {
  if (baseline !== 0) return candidate / baseline
  return candidate === 0 ? 1 : Number.POSITIVE_INFINITY
}

const metric = (group: Aggregate, path: string): number => {
  const value = group.median[path]
  if (value === undefined) throw new Error(`missing median metric ${path}`)
  return value
}

const key = (group: Aggregate): Case => group.case

export const compare = (input: {
  readonly baseline: ReadonlyArray<Aggregate>
  readonly candidate: ReadonlyArray<Aggregate>
}): Comparison => {
  const { baseline, candidate } = input
  const failures: Array<string> = []
  const ratios: Record<string, number> = {}
  const oldByCase = new Map(baseline.map((value) => [key(value), value]))
  const newByCase = new Map(candidate.map((value) => [key(value), value]))
  if (oldByCase.size !== cases.length || newByCase.size !== cases.length)
    failures.push("comparison requires Baton aggregates for all three cases")

  for (const [caseName, current] of newByCase) {
    const old = oldByCase.get(caseName)
    if (old === undefined) {
      failures.push(`${caseName}: baseline is missing`)
      continue
    }
    for (const sample of old.samples) {
      if (sample.output.sha256 !== outputSha256 || sample.output.bytes !== outputBytes)
        failures.push(`${caseName}: baseline semantic output differs from the canonical payload`)
      if (sample.correctness.terminalFinishes !== 1)
        failures.push(`${caseName}: baseline provider did not emit exactly one finish`)
    }
    for (const sample of current.samples) {
      if (sample.output.sha256 !== outputSha256 || sample.output.bytes !== outputBytes)
        failures.push(`${caseName}: semantic output differs from the canonical payload`)
      if (sample.correctness.durableModelParts !== 0) failures.push(`${caseName}: candidate persisted ModelPart`)
      if (sample.correctness.modelResponsesCommitted !== 1)
        failures.push(`${caseName}: candidate did not persist exactly one ModelResponseCommitted`)
      if (sample.correctness.terminalFinishes !== 1)
        failures.push(`${caseName}: provider did not emit exactly one finish`)
    }
    if (caseName !== "one") {
      for (const path of ["batonSql.totalEvents", "projection.commitProjectionCalls"] as const) {
        const oldValue = metric(old, path)
        const candidateValue = metric(current, path)
        if (oldValue === 0 && candidateValue === 0) continue
        const value = ratio(candidateValue, oldValue)
        ratios[`${caseName}:${path}`] = value
        if (value > 0.1) failures.push(`${caseName}: ${path} exceeds 10% of baseline`)
      }
    }
    const ceiling = caseName === "one" ? 1.2 : 1
    for (const path of [
      "timing.wallMilliseconds",
      "timing.cpuMilliseconds",
      "memory.peakHeapBytes",
      "memory.postGcHeapBytes",
      "memory.peakProcessTreeRssBytes",
      "memory.postGcProcessTreeRssBytes",
    ] as const) {
      if (current.median[path] === undefined || old.median[path] === undefined) continue
      const value = ratio(metric(current, path), metric(old, path))
      ratios[`${caseName}:${path}`] = value
      if (value > ceiling) failures.push(`${caseName}: ${path} regressed by ratio ${value.toFixed(3)}`)
    }
    for (const path of ["timing.firstPreviewMilliseconds", "timing.controlAckMilliseconds"] as const) {
      if (current.median[path] === undefined) continue
      const candidateValue = metric(current, path)
      if (candidateValue > 250) failures.push(`${caseName}: ${path} exceeded 250ms`)
      if (old.median[path] === undefined) continue
      const value = ratio(candidateValue, metric(old, path))
      ratios[`${caseName}:${path}`] = value
      if (value > 1.2) failures.push(`${caseName}: ${path} exceeded 1.2x baseline`)
    }
  }

  const candidateGroups = cases.flatMap((caseName) => {
    const value = newByCase.get(caseName)
    return value === undefined ? [] : [value]
  })
  if (candidateGroups.length === cases.length) {
    const eventCounts = new Set(
      candidateGroups.flatMap((group) => group.samples.map((sample) => sample.batonSql.totalEvents)),
    )
    const projectionCounts = new Set(
      candidateGroups.flatMap((group) => group.samples.map((sample) => sample.projection.commitProjectionCalls)),
    )
    if (eventCounts.size !== 1) failures.push("candidate event count is shape-dependent")
    if (projectionCounts.size !== 1) failures.push("candidate projection count is shape-dependent")
    const one = newByCase.get("one")!
    for (const group of candidateGroups) {
      for (const path of ["batonSql.eventJsonBytes", "batonSql.operationResultBytes"] as const) {
        const value = ratio(metric(group, path), Math.max(1, metric(one, path)))
        ratios[`${group.case}:${path}:candidate-amplification`] = value
        if (value > 1.2) failures.push(`${group.case}: ${path} exceeds 1.2x candidate one-case`)
      }
    }
  }
  return { pass: failures.length === 0, failures: [...new Set(failures)], ratios }
}
