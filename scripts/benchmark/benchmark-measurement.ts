export interface BenchMeasurement {
  readonly eventCount: number
  readonly commitBatch: number
  readonly wallSeconds: number
  readonly eventsPerSec: number
  readonly foldCpuSeconds: number
  readonly persistCpuSeconds: number
  readonly totalCpuSeconds: number
  readonly commitLatencyMsP50: number
  readonly commitLatencyMsP99: number
  readonly debounceCommitLatencyMsP50: number
}
