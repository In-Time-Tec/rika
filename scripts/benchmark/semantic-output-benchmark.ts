import { aggregate, compare } from "./semantic-output/comparison"
import { parse } from "./semantic-output/cli-options"
import type { Aggregate, Sample } from "./semantic-output/contract"
import { HostFiles } from "./semantic-output/host-files"
import { make as makeIsolation } from "./semantic-output/isolation"
import { create } from "./semantic-output/plan"
import { setup } from "./semantic-output/provision"

const options = parse(process.argv.slice(2))
const repositoryRoot = HostFiles.resolve(`${import.meta.dir}/../..`)
const outputRoot = HostFiles.resolve(options.output)
const plan = create({ outputRoot, sampleCount: options.samples })

if (options.command === "plan") {
  process.stdout.write(`${JSON.stringify({ options, plan }, null, 2)}\n`)
  process.exit(0)
}

if (options.command === "compare") {
  if (options.baseline === undefined || options.candidate === undefined)
    throw new Error("compare requires --baseline and --candidate aggregate JSON files")
  const baseline = JSON.parse(HostFiles.read(HostFiles.resolve(options.baseline))) as ReadonlyArray<Aggregate>
  const candidate = JSON.parse(HostFiles.read(HostFiles.resolve(options.candidate))) as ReadonlyArray<Aggregate>
  const comparison = compare({ baseline, candidate })
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`)
  process.exit(comparison.pass ? 0 : 1)
}

const provisioned = setup({
  repositoryRoot,
  output: outputRoot,
  candidateRelease: options.candidateBatonRelease!,
})
if (options.command === "setup") {
  process.stdout.write(`${JSON.stringify(provisioned, null, 2)}\n`)
  process.exit(0)
}

const samples: Array<Sample> = []
for (const run of plan) {
  const consumer = run.source === "baseline" ? provisioned.baselineConsumer : provisioned.candidateConsumer
  const identity = run.source === "baseline" ? provisioned.baselineIdentity : provisioned.candidateIdentity
  const isolation = makeIsolation(run.root)
  for (const directory of [isolation.root, isolation.cwd, isolation.home, isolation.temporary])
    HostFiles.mkdir(directory)
  const environment = Object.entries(isolation.environment).map(([key, value]) => `${key}=${value}`)
  const result = Bun.spawnSync(
    [
      "env",
      ...environment,
      "bun",
      "run",
      HostFiles.join(consumer, "semantic-output-worker.ts"),
      "--source",
      run.source,
      "--case",
      run.case,
      "--sample",
      String(run.sample),
      "--warmup",
      String(run.warmup),
      "--root",
      isolation.root,
      "--identity",
      identity,
    ],
    {
      cwd: isolation.cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (result.exitCode !== 0)
    throw new Error(
      `semantic worker ${run.sequence} failed (${result.exitCode})\n${result.stderr.toString()}\n${result.stdout.toString()}`,
    )
  const lines = result.stdout.toString().trim().split("\n")
  const sample = JSON.parse(lines.at(-1)!) as Sample
  samples.push(sample)
  process.stderr.write(
    `${run.sequence + 1}/${plan.length} ${run.source} ${run.case} ${run.warmup ? "warmup" : `sample ${run.sample}`} ${sample.timing.wallMilliseconds.toFixed(1)}ms\n`,
  )
}

const measured = samples.filter((sample) => !sample.warmup)
const aggregates = {
  baseline: optionsFor("baseline"),
  candidate: optionsFor("candidate"),
}
function optionsFor(source: "baseline" | "candidate"): ReadonlyArray<Aggregate> {
  return ["one", "ten-thousand", "alternating-empty"].map((caseName) =>
    aggregate(measured.filter((sample) => sample.source === source && sample.case === caseName)),
  )
}
const comparison = compare({ baseline: aggregates.baseline, candidate: aggregates.candidate })
const report = {
  schemaVersion: 1,
  configuration: {
    baseline: { rika: "v0.5.3 detached source", baton: "published 0.20.2" },
    candidate: { rika: "current source", batonRelease: HostFiles.resolve(options.candidateBatonRelease!) },
    mode: "baton",
    warmups: 1,
    measuredSamples: options.samples,
    serial: true,
    interleaved: true,
  },
  provisioned,
  plan,
  warmups: samples.filter((sample) => sample.warmup),
  raw: measured,
  medians: aggregates,
  comparison,
}
HostFiles.mkdir(outputRoot)
const reportPath = HostFiles.join(outputRoot, "semantic-output-result.json")
HostFiles.write(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ reportPath, comparison }, null, 2)}\n`)
process.exit(comparison.pass ? 0 : 1)
