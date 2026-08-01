import { Function } from "effect"

export type MetricDirection = "higher-is-better" | "lower-is-better" | "exact"
export type MetricOperator = "gte" | "lte" | "eq"

export interface PerformanceMetricPolicy {
  readonly id: string
  readonly operator: MetricOperator
  readonly direction: MetricDirection
  readonly target: number
  readonly tolerance: number
}

export interface MetricEvaluation {
  readonly id: string
  readonly baseline: number
  readonly candidate: number
  readonly target: number
  readonly operator: MetricOperator
  readonly pass: boolean
}

const lower = (id: string, target: number): PerformanceMetricPolicy => ({
  id,
  operator: "lte",
  direction: "lower-is-better",
  target,
  tolerance: 0.2,
})

const policies: ReadonlyArray<PerformanceMetricPolicy> = [
  lower("tui.initial-render", 150),
  lower("tui.picker-open.p95", 25),
  lower("tui.picker-navigation.p95", 12),
  lower("tui.current-thread-selection.p95", 16),
  lower("tui.scroll.p95", 12),
  lower("tui.stream-update.p95", 25),
  lower("tui.stream-update.p99", 16),
  lower("tui.render.p95", 16.7),
  lower("tui.mounted-rows", 6720),
  lower("process.rss-loaded", 500),
  lower("process.rss-interaction-growth", 10),
  lower("process.rss-after", 500),
  lower("process.heap-interaction-growth", 10),
  lower("process.launcher.idle-rss", 75),
  lower("process.interactive.idle-rss", 175),
  lower("process.resident.idle-rss", 250),
  lower("process.combined-idle-rss", 350),
  lower("process.idle-cpu.mean", 1),
  lower("process.idle-cpu.peak", 3),
]

export const performanceMetricPolicies = policies

export const metricPolicy = (id: string): PerformanceMetricPolicy | undefined =>
  policies.find((policy) => policy.id === id)

const targetPasses = (policy: PerformanceMetricPolicy, value: number): boolean => {
  switch (policy.operator) {
    case "lte":
      return value <= policy.target
    case "gte":
      return value >= policy.target
    case "eq":
      return value === policy.target
  }
}

const baselinePasses = (policy: PerformanceMetricPolicy, baseline: number, value: number): boolean => {
  if (policy.operator === "lte") return value <= baseline * (1 + policy.tolerance)
  if (policy.operator === "gte") return value >= baseline * (1 - policy.tolerance)
  return value === baseline
}

const evaluateMetricImpl = (
  policy: PerformanceMetricPolicy,
  baseline: number,
  candidate: number,
): MetricEvaluation => ({
  id: policy.id,
  baseline,
  candidate,
  target: policy.target,
  operator: policy.operator,
  pass: targetPasses(policy, candidate) && baselinePasses(policy, baseline, candidate),
})

export const evaluateMetric: {
  (baseline: number, candidate: number): (policy: PerformanceMetricPolicy) => MetricEvaluation
  (policy: PerformanceMetricPolicy, baseline: number, candidate: number): MetricEvaluation
} = Function.dual(3, evaluateMetricImpl)
