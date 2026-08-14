import { HostFiles } from "./host-files"
import { cases, type Case, type Source } from "./contract"

export interface PlannedRun {
  readonly sequence: number
  readonly source: Source
  readonly case: Case
  readonly sample: number
  readonly warmup: boolean
  readonly root: string
}

export const create = (input: {
  readonly outputRoot: string
  readonly sampleCount: number
}): ReadonlyArray<PlannedRun> => {
  const { outputRoot, sampleCount } = input
  if (!Number.isInteger(sampleCount) || sampleCount < 3)
    throw new Error("semantic benchmark requires at least three samples")
  const plan: Array<PlannedRun> = []
  const append = (source: Source, caseName: Case, sample: number, warmup: boolean) => {
    const sequence = plan.length
    plan.push({
      sequence,
      source,
      case: caseName,
      sample,
      warmup,
      root: HostFiles.join(
        outputRoot,
        "runs",
        `${String(sequence).padStart(3, "0")}-${source}-${caseName}-${warmup ? "warmup" : sample}`,
      ),
    })
  }
  for (const caseName of cases) {
    append("baseline", caseName, 0, true)
    append("candidate", caseName, 0, true)
    for (let sample = 1; sample <= sampleCount; sample += 1) {
      const order: ReadonlyArray<Source> = sample % 2 === 0 ? ["candidate", "baseline"] : ["baseline", "candidate"]
      for (const source of order) append(source, caseName, sample, false)
    }
  }
  return plan
}
