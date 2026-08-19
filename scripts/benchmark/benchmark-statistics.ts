export interface CpuSample {
  readonly userMicros: number
  readonly systemMicros: number
}

export const cpuSample = (): CpuSample => {
  const usage = process.cpuUsage()
  return { userMicros: usage.user, systemMicros: usage.system }
}

const percentile = (samples: ReadonlyArray<number>, ratio: number): number => {
  if (samples.length === 0) return 0
  const sorted = samples.toSorted((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index]!
}

export const summarizeLatencies = (samples: ReadonlyArray<number>) => ({
  p50: percentile(samples, 0.5),
  p99: percentile(samples, 0.99),
})

export const median = (samples: ReadonlyArray<number>): number => percentile(samples, 0.5)
