export type MetricDirection = "higher-is-better" | "lower-is-better"

export interface BaselineMetric {
  readonly value: number
  readonly direction: MetricDirection
}

export interface BenchBaseline {
  readonly version: 1
  readonly name: string
  readonly eventCount: number
  readonly commitBatch: number
  readonly recordedAt: string
  readonly host: string
  readonly metrics: {
    readonly eventsPerSec: BaselineMetric
    readonly foldCpuSeconds: BaselineMetric
    readonly persistCpuSeconds: BaselineMetric
    readonly commitLatencyMsP50: BaselineMetric
    readonly commitLatencyMsP99: BaselineMetric
    readonly debounceCommitLatencyMsP50: BaselineMetric
  }
}

export interface Regression {
  readonly metric: keyof BenchBaseline["metrics"]
  readonly baseline: number
  readonly current: number
  readonly direction: MetricDirection
  readonly changeRatio: number
}
