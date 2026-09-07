import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Effect, Layer, Schema } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"
import { cpus, freemem, totalmem } from "node:os"
import { measure } from "./measure"
import { scales } from "../../src/scenarios/stress"

const command = Command.make(
  "render-benchmark",
  {
    scale: Flag.choice("scale", ["small", "medium", "large", "extreme"]).pipe(Flag.withDefault("small")),
    iterations: Flag.integer("iterations").pipe(Flag.withDefault(10)),
    threads: Flag.integer("threads").pipe(Flag.withDefault(8)),
    streams: Flag.integer("streams").pipe(Flag.withDefault(8)),
    streamPlacement: Flag.choice("stream-placement", ["oldest", "newest"]).pipe(Flag.withDefault("oldest")),
    idleMs: Flag.integer("idle-ms").pipe(Flag.withDefault(250)),
    animate: Flag.boolean("animate").pipe(Flag.withDefault(false)),
    idleOnly: Flag.boolean("idle-only").pipe(Flag.withDefault(false)),
  },
  Effect.fn("Benchmark.command")(function* (options) {
    if (
      options.iterations < 1 ||
      options.iterations > 100 ||
      options.threads < 1 ||
      options.threads > 32 ||
      options.streams < 1 ||
      options.streams > 1_000 ||
      options.idleMs < 0 ||
      options.idleMs > 5_000
    ) {
      return yield* CliError.UserError.make({
        cause: "Benchmark bounds",
        userMessage: "Bounds: iterations 1–100, threads 1–32, streams 1–1000, idle-ms 0–5000.",
      })
    }
    const hardware = {
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      platform: process.platform,
      arch: process.arch,
    }
    const result = yield* Effect.scoped(measure({ ...scales[options.scale], ...options })).pipe(
      Effect.timeout("120 seconds"),
    )
    yield* Console.log(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        schemaVersion: 1,
        synthetic: true,
        description:
          "Headless Solid App rendering; deterministic batched concurrent stream updates, no model/network/workspace execution. Input timing includes the stream burst and flush, excludes assertion capture. Native timings are not terminal I/O throughput.",
        runtime: { bun: Bun.version, versions: process.versions },
        hardware,
        viewport: { width: 216, height: 62 },
        scale: options.scale,
        result,
      }),
    )
  }),
).pipe(Command.withDescription("Bounded synthetic renderer stress case; run each scale in a fresh process."))

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(BunServices.layer)
      yield* Effect.provide(Command.run(command, { version: "1" }), services)
    }),
  ),
)
