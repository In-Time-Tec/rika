import { describe, expect, test } from "vitest"
import { processObservationMetrics, publicProcessIdentity } from "../src/platform/application-performance-evaluation"
import { clientRuntime, matchesClientProcess } from "../src/platform/performance-platform"
import { observedClientRow, processSubtreeRss, type PsRow } from "../src/platform/performance-process-table"

describe("performance process observation", () => {
  test("locates the source client entrypoint", () => {
    const runtime = clientRuntime({
      packaged: false,
      executable: "/usr/bin/bun",
      sourceDirectory: "/repo/apps/rika/src",
    })
    expect(runtime).toEqual({
      kind: "source",
      executable: "/usr/bin/bun",
      arguments: ["/repo/apps/rika/src/client-main.ts"],
      evidencePath: "/repo/apps/rika/src/client-main.ts",
    })
  })

  test("locates the packaged client executable", () => {
    const runtime = clientRuntime({
      packaged: true,
      executable: "/install/bin/.rika-performance",
      sourceDirectory: "/install/bin",
    })
    expect(runtime).toEqual({
      kind: "packaged",
      executable: "/install/bin/rika",
      arguments: [],
      evidencePath: "/install/bin/rika",
    })
  })

  test("finds the packaged client in an ordinary process tree", () => {
    const runtime = clientRuntime({
      packaged: true,
      executable: "/install/bin/.rika-performance",
      sourceDirectory: "/install/bin",
    })
    const rows: ReadonlyArray<PsRow> = [
      { pid: 10, parent: 1, rss: 20_000, cpu: 0, cpuSeconds: 0, command: "/bin/sh" },
      { pid: 11, parent: 10, rss: 200_000, cpu: 0, cpuSeconds: 0, command: "/install/bin/rika" },
    ]
    expect(matchesClientProcess({ command: "/install/bin/rika", runtime })).toBe(true)
    expect(observedClientRow(rows, 10, runtime)?.pid).toBe(11)
  })

  test("sums client resident memory across its complete subtree", () => {
    const rows: ReadonlyArray<PsRow> = [
      { pid: 11, parent: 10, rss: 100, cpu: 0, cpuSeconds: 0, command: "/install/bin/rika" },
      { pid: 12, parent: 11, rss: 40, cpu: 0, cpuSeconds: 0, command: "worker" },
      { pid: 13, parent: 12, rss: 20, cpu: 0, cpuSeconds: 0, command: "worker-child" },
      { pid: 99, parent: 1, rss: 900, cpu: 0, cpuSeconds: 0, command: "unrelated" },
    ]
    expect(processSubtreeRss(rows, 11)).toBe(160)
  })

  test("evaluates a single client observation", () => {
    const metrics = processObservationMetrics({
      client: {
        pid: 11,
        executable: "rika",
        runtimeKind: "packaged",
        rssMebibytes: 120,
        cpuPercent: 0,
      },
      executableBytes: 42,
      sampleCount: 5,
      startupToProcessPresenceMilliseconds: 10,
      idleCpuMeanPercent: 0.1,
      idleCpuPeakPercent: 0.2,
    })
    expect(metrics.every((metric) => metric.status === "measured")).toBe(true)
    expect(metrics.map((metric) => metric.id)).toEqual([
      "process.client.idle-rss",
      "process.idle-cpu.mean",
      "process.idle-cpu.peak",
      "executable.client.file-bytes",
      "process.startup-to-client-presence",
    ])
  })

  test("redacts adversarial absolute paths from public process evidence", () => {
    const evidence = publicProcessIdentity({
      pid: 11,
      executable: "/Users/private-user/work/rika/apps/rika/src/client-main.ts",
      runtimeKind: "source",
    })
    expect(evidence).toEqual({
      pid: 11,
      runtimeKind: "source",
      executable: "client-main.ts",
    })
    expect(JSON.stringify(evidence)).not.toContain("private-user")
  })
})
