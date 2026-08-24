import { describe, expect, test } from "vitest"
import {
  comparePerformanceRuns,
  type PerformanceEvidence,
  type PerformanceMetricSample,
} from "../../scripts/benchmark/performance-comparison"
import { metricPolicy, performanceMetricPolicies } from "../../scripts/benchmark/performance-metric-policy"

const metric = (value: number, status: "measured" | "unsupported" = "measured"): PerformanceMetricSample => ({
  id: "tui.initial-render",
  unit: "milliseconds",
  value,
  status,
})

const run = (value: number, status: "measured" | "unsupported" = "measured"): PerformanceEvidence => ({
  schemaVersion: 1,
  evidence: { terminal: { columns: 120, rows: 36 }, processSamples: 5 },
  workload: { transcriptItems: 5006 },
  process: { platform: "darwin", architecture: "arm64", bun: "1.3.14" },
  metrics: [metric(value, status)],
})

const group = (value: number, status?: "measured" | "unsupported") => [
  run(value, status),
  run(value, status),
  run(value, status),
]

describe("performance metric policy", () => {
  test("lists the gated metric and lower-is-better tolerance", () => {
    expect(performanceMetricPolicies.length).toBeGreaterThan(0)
    expect(metricPolicy("tui.initial-render")).toEqual({
      id: "tui.initial-render",
      operator: "lte",
      direction: "lower-is-better",
      target: 150,
      tolerance: 0.2,
    })
  })

  test("gates the client subtree instead of obsolete process roles", () => {
    expect(metricPolicy("process.client.idle-rss")?.target).toBe(350)
    expect(performanceMetricPolicies.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([
        "process.launcher.idle-rss",
        "process.interactive.idle-rss",
        "process.server.idle-rss",
        "process.combined-idle-rss",
      ]),
    )
  })

  test("uses the median and requires both target and baseline tolerance", () => {
    expect(comparePerformanceRuns(group(100), group(115)).pass).toBe(true)
    expect(comparePerformanceRuns([run(100), run(100), run(200)], group(160)).pass).toBe(false)
    expect(comparePerformanceRuns(group(200), group(180)).pass).toBe(false)
  })

  test("rejects incompatible workloads, missing metrics, and a newly unsupported metric", () => {
    const incompatible = group(100).map((item) => ({ ...item, process: { ...item.process, bun: "other" } }))
    expect(comparePerformanceRuns(group(100), incompatible).failures[0]).toContain("incompatible")
    const missing = group(100).map((item) => ({ ...item, metrics: [] }))
    expect(comparePerformanceRuns(group(100), missing).failures[0]).toContain("incompatible")
    expect(comparePerformanceRuns(group(100), group(0, "unsupported")).failures[0]).toContain("unsupported")
  })

  test("retains unsupported baseline metrics as explicit residual gaps", () => {
    const result = comparePerformanceRuns(group(0, "unsupported"), group(0, "unsupported"))
    expect(result.pass).toBe(true)
    expect(result.unsupported).toEqual(["tui.initial-render"])
  })
})
