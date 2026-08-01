import { Context, Effect, FileSystem, Function, Layer, Path, Schema } from "effect"
import type { BenchBaseline, Regression } from "./benchmark-baseline-model"
import { baselineMetricsFromMeasurement } from "./benchmark-baseline-measurement"
import type { BenchMeasurement } from "./benchmark-measurement"

const BaselineMetricSchema = Schema.Struct({
  value: Schema.Finite,
  direction: Schema.Literals(["higher-is-better", "lower-is-better"]),
})

const BenchBaselineSchema = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String,
  eventCount: Schema.Finite,
  commitBatch: Schema.Finite,
  recordedAt: Schema.String,
  host: Schema.String,
  metrics: Schema.Struct({
    eventsPerSec: BaselineMetricSchema,
    foldCpuSeconds: BaselineMetricSchema,
    persistCpuSeconds: BaselineMetricSchema,
    commitLatencyMsP50: BaselineMetricSchema,
    commitLatencyMsP99: BaselineMetricSchema,
    debounceCommitLatencyMsP50: BaselineMetricSchema,
  }),
})

const BenchBaselineJson = Schema.fromJsonString(BenchBaselineSchema)

const benchRoot = Effect.runSync(
  Effect.scoped(
    Layer.build(Path.layer).pipe(
      Effect.flatMap((context) => Context.get(context, Path.Path).fromFileUrl(new URL(".", import.meta.url))),
    ),
  ),
)

export const baselinePath = (name: string) => `${benchRoot}/baselines/${name}.json`

export const loadBaseline = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.flatMap(Schema.decodeUnknownEffect(BenchBaselineJson)),
  )

const saveBaselineImpl = (path: string, baseline: BenchBaseline) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const encoded = yield* Schema.encodeEffect(BenchBaselineJson)(baseline)
    yield* fileSystem.makeDirectory(pathService.dirname(path), { recursive: true })
    yield* fileSystem.writeFileString(path, `${encoded}\n`)
  })

export const saveBaseline: {
  (baseline: BenchBaseline): (path: string) => Effect.Effect<void, import("effect/PlatformError").PlatformError>
  (path: string, baseline: BenchBaseline): Effect.Effect<void, import("effect/PlatformError").PlatformError>
} = Function.dual(2, saveBaselineImpl)

const compareBaselineImpl = (
  baseline: BenchBaseline,
  measurement: BenchMeasurement,
  tolerance = 0.2,
): ReadonlyArray<Regression> => {
  const current = baselineMetricsFromMeasurement(measurement)
  const regressions: Array<Regression> = []
  for (const metric of Object.keys(baseline.metrics) as Array<keyof BenchBaseline["metrics"]>) {
    const reference = baseline.metrics[metric]
    const observed = current[metric].value
    if (reference.value === 0) continue
    const changeRatio = observed / reference.value
    const regressed =
      reference.direction === "higher-is-better" ? changeRatio < 1 - tolerance : changeRatio > 1 + tolerance
    if (regressed)
      regressions.push({
        metric,
        baseline: reference.value,
        current: observed,
        direction: reference.direction,
        changeRatio,
      })
  }
  return regressions
}

export const compareBaseline: {
  (measurement: BenchMeasurement, tolerance?: number): (baseline: BenchBaseline) => ReadonlyArray<Regression>
  (baseline: BenchBaseline, measurement: BenchMeasurement, tolerance?: number): ReadonlyArray<Regression>
} = Function.dual((args) => typeof args[0] === "object" && "version" in args[0], compareBaselineImpl)
