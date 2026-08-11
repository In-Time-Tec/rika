import * as BunServices from "@effect/platform-bun/BunServices"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { afterEach, describe, expect, it } from "vitest"
import { makeCommand, type Options } from "../../scripts/benchmark/semantic-output/cli-options"
import { aggregate, compare } from "../../scripts/benchmark/semantic-output/comparison"
import type { Case, Sample, Source } from "../../scripts/benchmark/semantic-output/contract"
import {
  fileAccounting,
  fullEvidence,
  pageAccounting,
  sqlAccounting,
} from "../../scripts/benchmark/semantic-output/database-evidence"
import { HostFiles } from "../../scripts/benchmark/semantic-output/host-files"
import { assertSafe, make as makeIsolation } from "../../scripts/benchmark/semantic-output/isolation"
import { create as createPlan } from "../../scripts/benchmark/semantic-output/plan"
import { parse as parseProcessTable, rssBytes } from "../../scripts/benchmark/semantic-output/process-tree"
import { install } from "../../scripts/benchmark/semantic-output/provision"
import { makeWorkerCommand, type WorkerOptions } from "../../scripts/benchmark/semantic-output/worker-cli"
import {
  describe as describeWorkload,
  fragments,
  outputBytes,
  outputSha256,
} from "../../scripts/benchmark/semantic-output/workload"

const temporary: Array<string> = []
let temporarySequence = 0
const temp = () => {
  temporarySequence += 1
  const path = `/tmp/rika-semantic-output-test-${process.pid}-${temporarySequence}`
  HostFiles.remove(path)
  HostFiles.mkdir(path)
  temporary.push(path)
  return path
}
afterEach(() => {
  for (const path of temporary.splice(0)) HostFiles.remove(path)
})

describe("host file copying", () => {
  it("preserves a tracked directory symlink instead of following it", () => {
    const root = temp()
    const target = HostFiles.join(root, "target")
    const source = HostFiles.join(root, "source-link")
    const destination = HostFiles.join(root, "copy", "source-link")
    HostFiles.mkdir(target)
    HostFiles.write(HostFiles.join(target, "file.txt"), "target")
    expect(Bun.spawnSync(["ln", "-s", "target", source]).exitCode).toBe(0)

    HostFiles.copy(source, destination)

    expect(Bun.spawnSync(["test", "-L", destination]).exitCode).toBe(0)
    expect(Bun.spawnSync(["readlink", destination]).stdout.toString().trim()).toBe("target")
  })
})

describe("semantic output workload", () => {
  it("keeps every transport shape at exactly one million ASCII bytes and one hash", () => {
    expect(describeWorkload("one")).toMatchObject({ fragments: 1, nonemptyFragments: 1, outputBytes, outputSha256 })
    expect(describeWorkload("ten-thousand")).toMatchObject({
      fragments: 10_000,
      nonemptyFragments: 10_000,
      outputBytes,
      outputSha256,
    })
    expect(describeWorkload("alternating-empty")).toMatchObject({
      fragments: 10_000,
      nonemptyFragments: 5_000,
      outputBytes,
      outputSha256,
    })
    expect(fragments("ten-thousand").every((value) => value.length === 100)).toBe(true)
    expect(fragments("alternating-empty").every((value, index) => value.length === (index % 2 === 0 ? 0 : 200))).toBe(
      true,
    )
  })
})

describe("database evidence", () => {
  it("accounts for the database, live WAL and SHM, pages, checkpoint, tags, JSON, and operation bytes", () => {
    const filename = HostFiles.join(temp(), "baton.db")
    const database = new Database(filename)
    database.run("PRAGMA journal_mode=WAL")
    database.run("PRAGMA wal_autocheckpoint=0")
    database.run("CREATE TABLE baton_run_events (run_id TEXT, sequence INTEGER, event_json TEXT)")
    database.run("CREATE TABLE baton_run_operations (result_json TEXT)")
    database.run("CREATE TABLE baton_program_operations (result_json TEXT)")
    database.run("INSERT INTO baton_run_events VALUES ('run', 0, '{\"_tag\":\"ModelPart\"}')")
    database.run("INSERT INTO baton_run_events VALUES ('run', 1, '{\"_tag\":\"RunCompleted\"}')")
    database.run("INSERT INTO baton_run_operations VALUES ('abcd')")
    database.run("INSERT INTO baton_program_operations VALUES ('xy')")
    const files = fileAccounting(filename)
    expect(files.total).toBe(files.database + files.wal + files.shm)
    expect(files.wal).toBeGreaterThan(0)
    expect(files.shm).toBeGreaterThan(0)
    database.close(false)
    expect(pageAccounting(filename)).toMatchObject({ pageSize: expect.any(Number), freelistCount: 0 })
    expect(sqlAccounting(filename)).toMatchObject({
      totalEvents: 2,
      eventsByTag: { ModelPart: 1, RunCompleted: 1 },
      operationResultBytes: 6,
      modelPartEvents: 1,
      modelResponseCommittedEvents: 0,
    })
    expect(fullEvidence(filename)).toMatchObject({
      beforeCheckpoint: { total: expect.any(Number) },
      checkpoint: { busy: 0, logFrames: expect.any(Number), checkpointedFrames: expect.any(Number) },
      afterCheckpoint: { pageCount: expect.any(Number), liveBytes: expect.any(Number) },
    })
  })
})

describe("process tree evidence", () => {
  it("parses ps output and includes descendants regardless of row order", () => {
    const rows = parseProcessTable("  12  11  30\n10 1 100\n11 10 20\nnoise\n")
    expect(rows).toHaveLength(3)
    expect(rssBytes({ rows, rootPid: 10 })).toBe((100 + 20 + 30) * 1024)
    expect(rssBytes({ rows, rootPid: 11 })).toBe((20 + 30) * 1024)
  })
})

const makeSample = (
  source: Source,
  caseName: Case,
  sampleNumber: number,
  values: { events: number; eventBytes?: number },
): Sample => ({
  schemaVersion: 1,
  source,
  mode: "baton",
  case: caseName,
  sample: sampleNumber,
  warmup: false,
  output: { bytes: outputBytes, sha256: outputSha256 },
  correctness: {
    durableModelParts: source === "candidate" ? 0 : values.events,
    modelResponsesCommitted: source === "candidate" ? 1 : 0,
    terminalFinishes: 1,
  },
  timing: { wallMilliseconds: 10, cpuMilliseconds: 10, firstPreviewMilliseconds: 10, completionMilliseconds: 10 },
  memory: {
    peakHeapBytes: 100,
    postGcHeapBytes: 90,
    peakProcessTreeRssBytes: 200,
    postGcProcessTreeRssBytes: 180,
    bunHeapStats: {},
    allocatorRelief: { status: "unsupported", detail: "test" },
  },
  batonSql: {
    totalEvents: values.events,
    eventsByTag: {},
    eventJsonBytes: values.eventBytes ?? 1_000,
    operationResultBytes: 1_000,
    modelPartEvents: source === "candidate" ? 0 : values.events,
    modelResponseCommittedEvents: source === "candidate" ? 1 : 0,
  },
  projection: { commitProjectionCalls: 0 },
  databases: {},
  identity: {},
})

const eventCount = (source: Source, caseName: Case): number => {
  if (source === "candidate") return 5
  return caseName === "one" ? 6 : 100
}

const groups = (source: Source) =>
  (["one", "ten-thousand", "alternating-empty"] as const).map((caseName) =>
    aggregate(
      [1, 2, 3].map((sampleNumber) =>
        makeSample(source, caseName, sampleNumber, {
          events: eventCount(source, caseName),
        }),
      ),
    ),
  )

describe("aggregation and comparison", () => {
  it("aggregates medians and applies the ten-percent event gate only to flood cases", () => {
    const baseline = groups("baseline")
    const candidate = groups("candidate")
    expect(candidate[0]?.median["batonSql.totalEvents"]).toBe(5)
    const result = compare({ baseline, candidate })
    expect(result.pass).toBe(true)
    expect(result.failures).not.toContain("one: batonSql.totalEvents exceeds 10% of baseline")
    expect(result.ratios["ten-thousand:batonSql.totalEvents"]).toBe(0.05)
  })

  it("rejects shape-dependent candidate event counts and a flood regression", () => {
    const baseline = groups("baseline")
    const candidate = groups("candidate").map((group) =>
      group.case === "alternating-empty"
        ? aggregate([1, 2, 3].map((number) => makeSample("candidate", group.case, number, { events: 11 })))
        : group,
    )
    const result = compare({ baseline, candidate })
    expect(result.pass).toBe(false)
    expect(result.failures).toContain("candidate event count is shape-dependent")
    expect(result.failures).toContain("alternating-empty: batonSql.totalEvents exceeds 10% of baseline")
  })
})

describe("isolation and CLI planning", () => {
  it("places every explicit path beneath the run root and never in ~/.rika", () => {
    const root = temp()
    const isolation = makeIsolation(root)
    assertSafe({ isolation })
    expect(isolation.batonDatabase).toBe(HostFiles.join(root, "baton.db"))
    expect(isolation.environment.RIKA_DATABASE).toBe(HostFiles.join(root, "rika.db"))
    expect(Object.values(isolation.environment).join("\n")).not.toContain("/.rika")
  })

  it("plans one warmup and three serial interleaved samples for every source and case", () => {
    const plan = createPlan({ outputRoot: "/benchmark", sampleCount: 3 })
    expect(plan).toHaveLength(24)
    expect(plan.slice(0, 8).map(({ source, sample: sampleNumber, warmup }) => [source, sampleNumber, warmup])).toEqual([
      ["baseline", 0, true],
      ["candidate", 0, true],
      ["baseline", 1, false],
      ["candidate", 1, false],
      ["candidate", 2, false],
      ["baseline", 2, false],
      ["baseline", 3, false],
      ["candidate", 3, false],
    ])
  })
})

const runCli = (command: Parameters<typeof Command.runWith>[0], arguments_: ReadonlyArray<string>) =>
  Effect.runPromise(Command.runWith(command, { version: "0.0.0" })(arguments_).pipe(Effect.provide(BunServices.layer)))

describe("semantic output CLI", () => {
  it("routes the documented plan, setup, run, and compare commands through typed Effect CLI inputs", async () => {
    const received: Array<Options> = []
    const command = makeCommand((options) => Effect.sync(() => received.push(options)).pipe(Effect.asVoid))

    await runCli(command, ["plan", "--output", "/plan"])
    await runCli(command, ["setup", "--output", "/setup", "--candidate-baton-release", "/release"])
    await runCli(command, ["run", "--output", "/run", "--candidate-baton-release", "/release", "--samples", "5"])
    await runCli(command, [
      "compare",
      "--output",
      "/compare",
      "--baseline",
      "/baseline.json",
      "--candidate",
      "/candidate.json",
    ])

    expect(received).toEqual([
      {
        command: "plan",
        output: "/plan",
        samples: 3,
        baselineTag: "v0.5.3",
        baselineBatonVersion: "0.20.2",
      },
      {
        command: "setup",
        output: "/setup",
        samples: 3,
        candidateBatonRelease: "/release",
        baselineTag: "v0.5.3",
        baselineBatonVersion: "0.20.2",
      },
      {
        command: "run",
        output: "/run",
        samples: 5,
        candidateBatonRelease: "/release",
        baselineTag: "v0.5.3",
        baselineBatonVersion: "0.20.2",
      },
      {
        command: "compare",
        output: "/compare",
        samples: 3,
        baseline: "/baseline.json",
        candidate: "/candidate.json",
        baselineTag: "v0.5.3",
        baselineBatonVersion: "0.20.2",
      },
    ])
    await expect(
      runCli(command, ["run", "--output", "/run", "--candidate-baton-release", "/release", "--samples", "2"]),
    ).rejects.toThrow()
  })

  it("preserves the worker option contract and decodes typed values", async () => {
    const received: Array<WorkerOptions> = []
    const command = makeWorkerCommand((options) => Effect.sync(() => received.push(options)).pipe(Effect.asVoid))

    await runCli(command, [
      "--source",
      "candidate",
      "--case",
      "alternating-empty",
      "--sample",
      "7",
      "--warmup",
      "false",
      "--root",
      "/isolated",
      "--identity",
      "/identity.json",
    ])
    await runCli(command, [
      "--source",
      "baseline",
      "--case",
      "one",
      "--sample",
      "0",
      "--warmup",
      "true",
      "--root",
      "/warmup",
      "--identity",
      "/baseline-identity.json",
    ])

    expect(received).toEqual([
      {
        source: "candidate",
        case: "alternating-empty",
        sample: 7,
        warmup: false,
        root: "/isolated",
        identity: "/identity.json",
      },
      {
        source: "baseline",
        case: "one",
        sample: 0,
        warmup: true,
        root: "/warmup",
        identity: "/baseline-identity.json",
      },
    ])
  })
})

describe("benchmark provisioning install isolation", () => {
  it("passes a clean sibling Bun cache to install and rejects source-local caches", () => {
    const root = temp()
    const source = HostFiles.join(root, "sources", "rika-current")
    const cache = HostFiles.join(root, "install-cache", "candidate")
    HostFiles.mkdir(source)
    HostFiles.mkdir(cache)
    HostFiles.write(HostFiles.join(source, ".bun-install-cache", "legacy"), "old")
    HostFiles.write(HostFiles.join(cache, "stale"), "old")
    const calls: Array<{
      readonly command: ReadonlyArray<string>
      readonly cwd: string
      readonly environment: Readonly<Record<string, string>>
    }> = []

    const execute = (command: ReadonlyArray<string>, cwd: string, environment = {}) => {
      calls.push({ command, cwd, environment })
      return ""
    }
    install({ sourceRoot: source, cacheDirectory: cache, execute })

    expect(calls).toEqual([
      {
        command: ["bun", "install", "--linker=isolated"],
        cwd: source,
        environment: { BUN_INSTALL_CACHE_DIR: cache, NODE_OPTIONS: "", NODE_PATH: "" },
      },
    ])
    expect(HostFiles.exists(HostFiles.join(source, ".bun-install-cache"))).toBe(false)
    expect(HostFiles.exists(HostFiles.join(cache, "stale"))).toBe(false)
    expect(cache.startsWith(`${source}/`)).toBe(false)
    expect(() =>
      install({
        sourceRoot: source,
        cacheDirectory: HostFiles.join(source, ".bun-install-cache"),
        execute,
      }),
    ).toThrow("outside the provisioned source root")
  })
})
